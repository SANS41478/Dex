import { createServer } from 'node:net'
import type { AppError } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { createEventHub, type HubClient } from './event-hub'
import { describeEventServerError, startDemoEvents, startEventServer } from './event-server'

class FakeClient implements HubClient {
  readonly readyState = 1
  readonly received: string[] = []

  send(data: string): void {
    this.received.push(data)
  }

  on(_event: 'close', _listener: () => void): void {}
}

/** 取一个当下空闲的端口（先 bind(0) 问内核要，再释放）。 */
async function reservePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => {
    probe.close(() => resolve())
  })
  return port
}

describe('event server demo mode', () => {
  it('默认关闭时不写入演示图谱', () => {
    const hub = createEventHub()
    const stop = startDemoEvents(hub, false)
    const client = new FakeClient()
    hub.addClient(client)

    expect(client.received).toEqual([])
    expect(hub.hasCached('graph.snapshot')).toBe(false)
    stop()
  })

  it('显式开启时只通过 hub 发布一份共享演示状态', () => {
    const hub = createEventHub()
    const stop = startDemoEvents(hub, true)
    const first = new FakeClient()
    const second = new FakeClient()
    hub.addClient(first)
    hub.addClient(second)

    expect(hub.hasCached('graph.snapshot')).toBe(true)
    expect(first.received).toHaveLength(1)
    expect(second.received).toHaveLength(1)
    expect(JSON.parse(first.received[0] ?? '')).toMatchObject({
      type: 'graph.snapshot',
      payload: JSON.parse(second.received[0] ?? '').payload,
    })
    stop()
  })
})

describe('event server bind failure', () => {
  it('EADDRINUSE 被翻译成可判别的错误码与文案', () => {
    const failure = describeEventServerError(
      Object.assign(new Error('listen EADDRINUSE: address already in use'), {
        code: 'EADDRINUSE',
      }),
      4319,
    )
    expect(failure.code).toBe('EVENT_SERVER_PORT_IN_USE')
    expect(failure.message).toContain('4319')
    expect(failure.retryable).toBe(true)
  })

  it('其它绑定错误落到通用码，仍可重试', () => {
    const failure = describeEventServerError(new Error('boom'), 4319)
    expect(failure.code).toBe('EVENT_SERVER_FAILED')
    expect(failure.message).toContain('boom')
    expect(failure.retryable).toBe(true)
  })

  it('端口已被占用时经 onBindError 上报，不静默吞掉', async () => {
    const port = await reservePort()
    const blocker = new WebSocketServer({ host: '127.0.0.1', port })
    await new Promise<void>((resolve) => {
      blocker.once('listening', resolve)
    })

    const failures: AppError[] = []
    const stop = startEventServer(createEventHub(), port, {
      onBindError: (error) => failures.push(error),
    })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(failures).toHaveLength(1)
    expect(failures[0]?.code).toBe('EVENT_SERVER_PORT_IN_USE')

    stop()
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve())
    })
  })
})
