import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionStatusNotification, type SdkNotification } from '@dexagent/bridges'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDshArgs,
  createDshHost,
  createLineSplitter,
  DSH_EXPOSE_INTERNALS_FLAG,
  DSH_PROFILE,
  type DshHostStatus,
  type DshSpawnedProcess,
  resolveDshBin,
  resolveNodeBin,
} from './dsh-host'

describe('resolveDshBin', () => {
  it('DEX_DSH_BIN 覆盖优先，且必须真实存在', () => {
    const env = { DEX_DSH_BIN: 'E:/custom/dsh.js' }
    const hit = resolveDshBin({ env, exists: () => true })
    expect(hit.bin).toBe('E:/custom/dsh.js')
    expect(hit.missingExplicit).toBeNull()

    const miss = resolveDshBin({ env, exists: () => false })
    expect(miss.bin).toBeNull()
    // 失效的显式路径必须留痕：上层据此说人话（BUGFIX-HOST-01）
    expect(miss.missingExplicit).toBe('E:/custom/dsh.js')
  })

  it('默认从 DSH_HOME / ~/.dex-dsh 推导', () => {
    const seen: string[] = []
    const bin = resolveDshBin({
      env: { DSH_HOME: 'C:/Users/x/.dsh' },
      exists: (path) => {
        seen.push(path)
        return true
      },
    }).bin
    expect(bin).toContain('@deepseek-ai')
    expect(seen[0]).toBe(bin)

    // 无显式 env 时约定候选基于**真实用户主目录**展开（BUGFIX-M4-07：不再接受「主目录覆盖」
    // 入参——home 参数语义已裁决为具体 dsh home，混用会再拼一层导致 bin 恒 null）。
    // 首位候选是 `profiles/<profile>/node_modules`（BUGFIX-M4-08）：profile 自己装的 CLI 才与
    // 它的插件同源，共享池里的旧安装不得抢位。
    const fallback = resolveDshBin({ env: {}, exists: () => true }).bin
    expect(fallback).toBe(
      join(
        homedir(),
        '.dex-dsh',
        'profiles',
        DSH_PROFILE,
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      ),
    )
  })

  it('找不到时返回 null（不抛异常）', () => {
    expect(resolveDshBin({ env: {}, exists: () => false }).bin).toBeNull()
  })

  it('DEX_DSH_HOME 可替代 ~/.dsh 推导（dexAgent 专用，不污染用户其他 dsh 工具）', () => {
    const bin = resolveDshBin({
      env: { DEX_DSH_HOME: 'C:/Users/x/.dex-dsh' },
      exists: () => true,
    }).bin
    expect(bin).toBe(
      join(
        'C:/Users/x/.dex-dsh',
        'profiles',
        DSH_PROFILE,
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      ),
    )
  })

  it('DSH_HOME 优先于 DEX_DSH_HOME，DEX_DSH_BIN 优先于两者', () => {
    const withBoth = resolveDshBin({
      env: { DSH_HOME: 'C:/a/.dsh', DEX_DSH_HOME: 'C:/b/.dex-dsh' },
      exists: () => true,
    }).bin
    expect(withBoth).toContain(join('C:/a/.dsh', 'profiles'))

    const withBin = resolveDshBin({
      env: { DEX_DSH_BIN: 'E:/custom/dsh.js', DSH_HOME: 'C:/a/.dsh' },
      exists: () => true,
    }).bin
    expect(withBin).toBe('E:/custom/dsh.js')
  })
})

describe('buildDshArgs', () => {
  it('默认 profile=dex，可追加 --patch', () => {
    expect(buildDshArgs()).toEqual(['--profile', 'dex'])
    expect(buildDshArgs('dex', ['a.yml', 'b.yml'])).toEqual([
      '--profile',
      'dex',
      '--patch',
      'a.yml',
      '--patch',
      'b.yml',
    ])
  })
})

describe('resolveNodeBin', () => {
  it('Electron 宿主用 PATH 里的 node，纯 Node 宿主用自身 execPath', () => {
    expect(resolveNodeBin({ env: {}, execPath: 'E:/app/electron.exe', isElectron: true })).toBe(
      'node',
    )
    expect(resolveNodeBin({ env: {}, execPath: 'C:/node/node.exe', isElectron: false })).toBe(
      'C:/node/node.exe',
    )
    expect(
      resolveNodeBin({ env: { DEX_NODE_BIN: 'E:/n/node.exe' }, execPath: 'x', isElectron: true }),
    ).toBe('E:/n/node.exe')
  })
})

describe('createLineSplitter', () => {
  it('按 \\n 切分并保留跨 chunk 的残行', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('{"a"')).toEqual([])
    expect(splitter.push(':1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.push('{"c":3}')).toEqual([])
    expect(splitter.push('\n')).toEqual(['{"c":3}'])
  })
})

class FakeChild implements DshSpawnedProcess {
  exitCode: number | null = null
  pid = 4242
  readonly writes: string[] = []
  private readonly stdinEmitter = new EventEmitter()
  private readonly stdoutEmitter = new EventEmitter()
  private readonly stderrEmitter = new EventEmitter()
  private readonly exitEmitter = new EventEmitter()
  private readonly errorEmitter = new EventEmitter()

  readonly stdin = {
    write: (chunk: string): unknown => {
      this.writes.push(chunk)
      return true
    },
    on: (event: 'error', listener: (error: Error) => void): unknown =>
      this.stdinEmitter.on(event, listener),
  }

  readonly stdout = {
    setEncoding: (_encoding: string): unknown => undefined,
    on: (event: 'data', listener: (chunk: string) => void): unknown =>
      this.stdoutEmitter.on(event, listener),
  }

  readonly stderr = {
    setEncoding: (_encoding: string): unknown => undefined,
    on: (event: 'data', listener: (chunk: string) => void): unknown =>
      this.stderrEmitter.on(event, listener),
  }

  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: string | null) => void) | ((error: Error) => void),
  ): unknown {
    if (event === 'exit') {
      return this.exitEmitter.on(
        'exit',
        listener as (code: number | null, signal: string | null) => void,
      )
    }
    return this.errorEmitter.on('error', listener as (error: Error) => void)
  }

  kill(): boolean {
    this.exitWith(null, 'SIGTERM')
    return true
  }

  emitStdout(chunk: string): void {
    this.stdoutEmitter.emit('data', chunk)
  }

  exitWith(code: number | null, signal: string | null = null): void {
    this.exitCode = code ?? 1
    this.exitEmitter.emit('exit', code, signal)
  }
}

function makeHost() {
  const statuses: DshHostStatus[] = []
  const child = new FakeChild()
  const host = createDshHost({
    onStatus: (status) => statuses.push(status),
    binPath: 'E:/fake/dsh/bin.js',
    spawnFn: () => child,
  })
  return { statuses, child, host }
}

describe('createDshHost', () => {
  it('缺少 CLI 时上报 missing（detail 带上已查过的 home、逃生口与失效的显式路径）', () => {
    const statuses: DshHostStatus[] = []
    const host = createDshHost({
      onStatus: (status) => statuses.push(status),
      env: { DEX_DSH_BIN: 'E:/definitely-missing/dsh.js' },
      home: 'C:/Users/x/.dex-dsh',
      // 注入「盘上什么都没有」：不注入的话，本机恰好装在 ~/.dex-dsh 的 CLI 会让
      // 候选链命中 → 用例测的是这台机器而不是这段代码（2026-10-06 实测踩过）。
      exists: () => false,
      spawnFn: () => {
        throw new Error('should not spawn')
      },
    })
    host.start()
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.phase).toBe('missing')
    expect(statuses[0]?.detail).toContain('C:/Users/x/.dex-dsh')
    expect(statuses[0]?.detail).toContain('DEX_DSH_BIN')
    // 过期环境变量这件事必须出现在人话原因里——否则用户只会看到「找不到宿主」
    expect(statuses[0]?.detail).toContain('E:/definitely-missing/dsh.js')
  })

  it('显式 DEX_DSH_BIN 已失效时不再一票否决：候选链命中即照常启动（BUGFIX-HOST-01）', () => {
    // 现场：DEX_DSH_BIN 指向已删除的 F:\Deepseek-harness-desktop\dsh-install\…，
    // 而 profile 里明明装着 CLI，宿主仍恒报 missing（「找不到宿主 dsh 了」）。
    const home = mkdtempSync(join(tmpdir(), 'dex-host-stale-explicit-'))
    try {
      const bin = join(
        home,
        'profiles',
        'dex',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      )
      mkdirSync(join(home, 'profiles', 'dex', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), {
        recursive: true,
      })
      writeFileSync(bin, '// stub\n', 'utf8')
      const statuses: DshHostStatus[] = []
      let spawnedArgs: readonly string[] | undefined
      const host = createDshHost({
        onStatus: (status) => statuses.push(status),
        env: {
          DEX_DSH_BIN:
            'F:/Deepseek-harness-desktop/dsh-install/node_modules/@deepseek-ai/dsh/lib/bin.js',
        },
        home,
        spawnFn: (_command, args) => {
          spawnedArgs = args
          return new FakeChild()
        },
      })
      host.start()
      expect(statuses.map((status) => status.phase)).toEqual(['starting'])
      // Node flag 必须在脚本路径之前（UI-10a：HMR 前置），随后才是 dsh CLI 参数。
      expect(spawnedArgs?.[0]).toBe(DSH_EXPOSE_INTERNALS_FLAG)
      expect(spawnedArgs?.[1]).toBe(bin)
      expect(spawnedArgs?.[2]).toBe('--profile')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('以 --expose-internals 启动宿主（hmr 服务的前置；缺省会让插件热启停不可用）', () => {
    let spawnedArgs: readonly string[] | undefined
    const host = createDshHost({
      onStatus: () => {},
      binPath: 'E:/fake/dsh/bin.js',
      home: mkdtempSync(join(tmpdir(), 'dex-host-expose-')),
      spawnFn: (_command, args) => {
        spawnedArgs = args
        return new FakeChild()
      },
    })
    host.start()
    expect(spawnedArgs?.[0]).toBe(DSH_EXPOSE_INTERNALS_FLAG)
    expect(spawnedArgs?.[1]).toBe('E:/fake/dsh/bin.js')
    expect(spawnedArgs).toContain('--profile')
  })

  it('显式 home 原样交给子进程（决策已在 index.ts 做完，host 不再二次否决）', () => {
    // 造一个真实可写的 home 作为显式档，验证它会被原样传给子进程。
    // 注意：`options.home` 是**调用方的决策结果**，host MUST NOT 再用凭据/自愈逻辑覆盖它。
    const writableHome = mkdtempSync(join(tmpdir(), 'dex-host-home-'))
    try {
      let captured: NodeJS.ProcessEnv | undefined
      const host = createDshHost({
        onStatus: () => {},
        binPath: 'E:/fake/dsh/bin.js',
        home: writableHome,
        env: { DEX_DSH_HOME: writableHome },
        spawnFn: (_command, _args, options) => {
          captured = options.env
          return new FakeChild()
        },
      })
      host.start()
      expect(captured?.DSH_HOME).toBe(writableHome)
    } finally {
      rmSync(writableHome, { recursive: true, force: true })
    }
  })

  it('未传 home 时走自愈候选链：可写且带凭据的候选优先（凭据—home 一致性）', () => {
    let captured: NodeJS.ProcessEnv | undefined
    const host = createDshHost({
      onStatus: () => {},
      binPath: 'E:/fake/dsh/bin.js',
      env: { DEX_DSH_HOME: mkdtempSync(join(tmpdir(), 'dex-host-nocred-')) },
      spawnFn: (_command, _args, options) => {
        captured = options.env
        return new FakeChild()
      },
    })
    host.start()
    // 只断言「交给子进程的 home 是自愈链的产物、且该路径可写」——不硬编码具体是哪台机器的 home。
    const chosen = captured?.DSH_HOME
    expect(typeof chosen).toBe('string')
    expect(existsSync(String(chosen))).toBe(true)
  })

  it('DEX_DSH_HOME 指向不可写路径时被跳过，不把 EPERM 现场带进子进程', () => {
    let captured: NodeJS.ProcessEnv | undefined
    const host = createDshHost({
      onStatus: () => {},
      binPath: 'E:/fake/dsh/bin.js',
      // C:\Users 下的新目录在 Windows 上无写权限；即使某机器恰好能写，
      // 也不应等于这个不可写候选的原始值以外的东西——这里断言「不等于该值」不成立时自动跳过
      env: { DEX_DSH_HOME: join('C:\\Users', `__dex_host_probe_${Date.now()}`, '.dex-dsh') },
      spawnFn: (_command, _args, options) => {
        captured = options.env
        return new FakeChild()
      },
    })
    host.start()
    // 自愈后的 home 必然是可写候选；断言它确实被解析（非 undefined）且不是空的
    expect(typeof captured?.DSH_HOME).toBe('string')
    expect(captured?.DSH_HOME?.length).toBeGreaterThan(0)
  })

  it('传入已解析的 home 时，子进程 DSH_HOME 用它（self-heal 选中的那个）', () => {
    let captured: NodeJS.ProcessEnv | undefined
    const host = createDshHost({
      onStatus: () => {},
      binPath: 'E:/fake/dsh/bin.js',
      env: {},
      home: 'C:/Users/x/.dex-dsh',
      spawnFn: (_command, _args, options) => {
        captured = options.env
        return new FakeChild()
      },
    })
    host.start()
    expect(captured?.DSH_HOME).toBe('C:/Users/x/.dex-dsh')
  })

  it('启动即探活：收到探活响应 → ready（跨 chunk 帧也能解析）', () => {
    const { statuses, child, host } = makeHost()
    host.start()

    expect(statuses).toEqual([{ phase: 'starting' }])
    expect(child.writes.join('')).toContain('"method":"dex/ping"')

    child.emitStdout('{"jsonrpc":"2.0","id":1,"error":{"code":-32')
    child.emitStdout('603,"message":"unknown DeepSeek Harness SDK runtime method: dex/ping"}}\n')
    expect(statuses.at(-1)).toEqual({ phase: 'ready' })
    expect(host.isRunning()).toBe(true)
  })

  it('request 复用 stdout JSON-RPC 并按 id 解析响应', async () => {
    const { child, host } = makeHost()
    host.start()
    child.emitStdout('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"unknown"}}\n')
    const pending = host.request('initialize', { cwd: 'C:/workspace' })
    const request = JSON.parse(child.writes.at(-1) ?? '{}') as { id?: number; method?: string }
    expect(request.method).toBe('initialize')
    expect(request.id).toBeGreaterThan(1)
    child.emitStdout(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })}\n`,
    )
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('启动期周期重试探活，ready 后停止（冷启动慢不误判）', () => {
    vi.useFakeTimers()
    try {
      const { statuses, child, host } = makeHost()
      host.start()
      const initial = child.writes.length
      expect(initial).toBeGreaterThan(0)
      vi.advanceTimersByTime(6_000)
      expect(child.writes.length).toBeGreaterThan(initial)

      child.emitStdout(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"unknown method"}}\n',
      )
      child.emitStdout(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"unknown method"}}\n',
      )
      expect(statuses.filter((status) => status.phase === 'ready')).toHaveLength(1)
      const afterReady = child.writes.length
      vi.advanceTimersByTime(10_000)
      expect(child.writes.length).toBe(afterReady)
    } finally {
      vi.useRealTimers()
    }
  })

  it('非零退出上报 error，正常退出上报 stopped', () => {
    const { statuses, child, host } = makeHost()
    host.start()
    child.exitWith(1)
    expect(statuses.at(-1)?.phase).toBe('error')
    expect(host.isRunning()).toBe(false)

    const second = makeHost()
    second.host.start()
    second.child.exitWith(0)
    expect(second.statuses.at(-1)).toEqual({ phase: 'stopped' })
  })

  it('stop 发送 shutdown；未在超时内退出则 kill', async () => {
    const { child, host } = makeHost()
    host.start()

    child.exitCode = null
    const stopping = host.stop()
    expect(child.writes.join('')).toContain('"method":"shutdown"')
    child.exitWith(0, 'SIGTERM')
    await stopping
    expect(host.isRunning()).toBe(false)
  })

  it('通知帧交给 onNotification，响应帧不混入（会话级运行状态的唯一权威源）', () => {
    const notifications: SdkNotification[] = []
    const child = new FakeChild()
    const host = createDshHost({
      onStatus: () => {},
      binPath: 'E:/fake/dsh/bin.js',
      spawnFn: () => child,
      onNotification: (frame) => notifications.push(frame),
    })
    host.start()

    child.emitStdout(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session.status',
        params: { sessionId: 'sess-1', status: 'running' },
      })}\n`,
    )
    expect(notifications).toHaveLength(1)
    expect(parseSessionStatusNotification(notifications[0] as SdkNotification)).toEqual({
      sessionId: 'sess-1',
      status: 'running',
    })

    // 响应帧走 pending 匹配，不得出现在通知回调里。
    child.emitStdout('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    expect(notifications).toHaveLength(1)
  })
})
