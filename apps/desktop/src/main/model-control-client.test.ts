import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  createModelControlClient,
  isRetryableConnectError,
  ModelControlError,
} from './model-control-client'

interface ControlRequestBody {
  readonly requestId: string
  readonly method: string
  readonly namespace?: string
  readonly expectedRevision?: number
}

interface ControlServerHandle {
  readonly close: () => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** 取一个当前空闲的端口（先占住问系统，再立刻释放）。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

/**
 * 起一个控制路由替身：先挂好连接处理器，再等 `delayMs` 才真正 listen。
 * 用来复现「请求已发出、宿主还没开始监听」的启动竞态。
 */
async function startControlServer(
  port: number,
  onRequest: (body: ControlRequestBody, socket: WebSocket) => void,
  delayMs = 0,
): Promise<ControlServerHandle> {
  const httpServer = createHttpServer()
  const server = new WebSocketServer({ server: httpServer, path: '/dex-control' })
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      onRequest(JSON.parse(String(raw)) as ControlRequestBody, socket)
    })
  })

  await sleep(delayMs)
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, '127.0.0.1', () => resolve())
  })

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(() => {
          httpServer.close(() => resolve())
        })
      }),
  }
}

function replyOk(body: ControlRequestBody, socket: WebSocket, result: unknown): void {
  socket.send(JSON.stringify({ ok: true, requestId: body.requestId, result }))
}

describe('isRetryableConnectError', () => {
  it('把「宿主还没开始监听」类错误判为可重试', () => {
    const withCode = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4320'), {
      code: 'ECONNREFUSED',
    })
    expect(isRetryableConnectError(withCode)).toBe(true)
    // ws 在某些路径上不带 code，只能靠文案识别
    expect(isRetryableConnectError(new Error('connect ECONNREFUSED 127.0.0.1:4320'))).toBe(true)
    expect(isRetryableConnectError(new Error('socket hang up'))).toBe(true)
  })

  it('不把业务错误判为可重试', () => {
    expect(isRetryableConnectError(new Error('模型控制请求超时'))).toBe(false)
    expect(isRetryableConnectError(new Error('Unexpected server response: 404'))).toBe(false)
  })
})

describe('createModelControlClient 启动竞态', () => {
  it('宿主尚未监听时退避重试，就绪后成功（复现 ECONNREFUSED 场景）', async () => {
    const port = await freePort()
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 8_000)

    // 请求先发出去（t≈0），宿主 800ms 后才开始监听 —— 这就是用户现场
    const pending = client.listSessions()
    const handle = await startControlServer(
      port,
      (body, socket) => {
        replyOk(body, socket, { sessions: [] })
      },
      800,
    )

    try {
      await expect(pending).resolves.toEqual({ sessions: [] })
    } finally {
      await handle.close()
    }
  })

  it('业务错误不重试，立即失败', async () => {
    const port = await freePort()
    const handle = await startControlServer(port, (body, socket) => {
      socket.send(
        JSON.stringify({
          ok: false,
          requestId: body.requestId,
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'provider 未配置', retryable: false },
        }),
      )
    })
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 5_000)

    try {
      await expect(client.listSessions()).rejects.toThrow('provider 未配置')
    } finally {
      await handle.close()
    }
  })

  it('宿主始终未就绪时在超时预算内失败，不会无限重试', async () => {
    const port = await freePort()
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 1_500)

    const started = Date.now()
    await expect(client.listSessions()).rejects.toThrow()
    const elapsed = Date.now() - started

    // 必须真的重试过（不止一次），但也不能超出超时预算太多
    expect(elapsed).toBeGreaterThan(300)
    expect(elapsed).toBeLessThan(2_500)
  })

  it('默认预算够 dsh 实测冷启动（23.2s）用', () => {
    expect(CONTROL_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('宿主已进入终态时立刻失败并给出人话原因，不空转整份预算', async () => {
    const port = await freePort()
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 45_000, {
      hostFailure: () => 'dsh 宿主启动失败：dsh 退出（code=1 signal=null）',
    })

    const started = Date.now()
    await expect(client.listSessions()).rejects.toThrow('dsh 宿主启动失败')
    // 首次尝试前就判定终态，因此几乎不耗时（远小于 45s 预算）
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('终态原因随宿主状态变化：恢复非终态后重新走重试', async () => {
    const port = await freePort()
    let failure: string | null = '未找到 dsh 宿主：未解析到 dsh CLI'
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 8_000, {
      hostFailure: () => failure,
    })

    await expect(client.listSessions()).rejects.toThrow('未找到 dsh 宿主')

    // 宿主被修好后（终态解除）请求应恢复正常的退避重试路径
    failure = null
    const pending = client.listSessions()
    const handle = await startControlServer(
      port,
      (body, socket) => {
        replyOk(body, socket, { sessions: [] })
      },
      400,
    )
    try {
      await expect(pending).resolves.toEqual({ sessions: [] })
    } finally {
      await handle.close()
    }
  })
})

describe('createModelControlClient 全局设置', () => {
  const namespace = {
    autoGenerate: true,
    ns: 'general',
    schema: { uid: 'root', refs: { root: { type: 'object' } } },
    value: { enabled: true },
    applies: 'live' as const,
    secrets: [{ path: ['token'], set: true }],
    revision: 6,
  }

  it('通过 describe 读取脱敏 namespace，并用 revision 执行路径变更', async () => {
    const port = await freePort()
    const methods: ControlRequestBody[] = []
    const handle = await startControlServer(port, (body, socket) => {
      methods.push(body)
      if (body.method === 'settings/describe') {
        replyOk(body, socket, { writable: true, hasDocument: true, namespaces: [namespace] })
      } else {
        replyOk(body, socket, namespace)
      }
    })
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 5_000)

    try {
      await expect(client.settingsDescribe()).resolves.toMatchObject({
        writable: true,
        namespaces: [{ ns: 'general', revision: 6 }],
      })
      await expect(
        client.settingsMutate({
          namespace: 'general',
          operations: [{ op: 'set', path: ['enabled'], value: false }],
          expectedRevision: 6,
        }),
      ).resolves.toMatchObject({ ns: 'general', revision: 6 })
      expect(methods.map((item) => item.method)).toEqual(['settings/describe', 'settings/mutate'])
      expect(methods[1]).toMatchObject({ namespace: 'general', expectedRevision: 6 })
    } finally {
      await handle.close()
    }
  })

  it('保留 SETTING_CONFLICT 机器码供界面刷新', async () => {
    const port = await freePort()
    const handle = await startControlServer(port, (body, socket) => {
      socket.send(
        JSON.stringify({
          ok: false,
          requestId: body.requestId,
          error: {
            code: 'SETTINGS_CONFLICT',
            message: 'settings changed since revision 6',
            retryable: false,
          },
        }),
      )
    })
    const client = createModelControlClient(`ws://127.0.0.1:${port}/dex-control`, 5_000)

    try {
      await expect(
        client.settingsMutate({
          namespace: 'general',
          operations: [{ op: 'set', path: ['enabled'], value: false }],
          expectedRevision: 6,
        }),
      ).rejects.toMatchObject({
        code: 'SETTINGS_CONFLICT',
        name: ModelControlError.name,
      })
    } finally {
      await handle.close()
    }
  })
})
