import { makeMessage } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { createEventHub, type HubClient } from './event-hub'

class FakeClient implements HubClient {
  readyState = 1
  readonly received: string[] = []
  private readonly closeListeners: (() => void)[] = []

  send(data: string): void {
    this.received.push(data)
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.push(listener)
  }

  close(): void {
    this.readyState = 3
    for (const listener of [...this.closeListeners]) listener()
  }
}

describe('event hub', () => {
  it('广播到所有打开连接', () => {
    const hub = createEventHub()
    const a = new FakeClient()
    const b = new FakeClient()
    hub.addClient(a)
    hub.addClient(b)

    hub.broadcast(makeMessage('host.status', { phase: 'ready' }))

    expect(a.received).toHaveLength(1)
    expect(b.received).toHaveLength(1)
    expect(JSON.parse(a.received[0] ?? '')).toMatchObject({
      type: 'host.status',
      payload: { phase: 'ready' },
    })
  })

  it('跳过已关闭连接，并在 close 后移除', () => {
    const hub = createEventHub()
    const client = new FakeClient()
    hub.addClient(client)
    client.readyState = 3

    hub.broadcast(makeMessage('host.status', { phase: 'starting' }))
    expect(client.received).toHaveLength(0)

    client.readyState = 1
    client.close()
    hub.broadcast(makeMessage('host.status', { phase: 'stopped' }))
    expect(client.received).toHaveLength(0)
    expect(hub.clientCount()).toBe(0)
  })

  it('状态类消息接入后，新客户端拿到最新宿主状态', () => {
    const hub = createEventHub()
    expect(hub.hasCached('host.status')).toBe(false)
    hub.publish(makeMessage('host.status', { phase: 'starting' }))
    hub.publish(makeMessage('host.status', { phase: 'ready' }))
    expect(hub.hasCached('host.status')).toBe(true)

    const late = new FakeClient()
    hub.addClient(late)

    expect(late.received.map((raw) => JSON.parse(raw).payload.phase)).toEqual(['ready'])
  })

  it('upsert/remove 折叠进状态，新客户端拿到合并后的新鲜快照', () => {
    const hub = createEventHub()
    hub.publish(
      makeMessage('graph.snapshot', {
        nodes: [{ id: 'a', label: 'a', type: 'tool', status: 'active' }],
        links: [],
      }),
    )
    hub.publish(
      makeMessage('graph.upsert', {
        nodes: [{ id: 'b', label: 'b', type: 'tool', status: 'active' }],
        links: [{ id: 'inject:a:b', source: 'a', target: 'b', type: 'inject' }],
      }),
    )
    hub.publish(makeMessage('graph.remove', { nodeIds: ['a'], linkIds: ['inject:a:b'] }))

    const late = new FakeClient()
    hub.addClient(late)
    const snapshot = JSON.parse(late.received[0] ?? '')

    expect(snapshot.type).toBe('graph.snapshot')
    expect(snapshot.payload.nodes.map((node: { id: string }) => node.id)).toEqual(['b'])
    expect(snapshot.payload.links).toEqual([])
    expect(hub.hasCached('graph.snapshot')).toBe(true)
  })

  it('无图谱数据时不向新客户端发空快照（避免清掉演示数据）', () => {
    const hub = createEventHub()
    const client = new FakeClient()
    hub.addClient(client)
    expect(client.received).toEqual([])
  })

  it('trace 消息折叠为 canonical 状态并回放完整快照', () => {
    const hub = createEventHub()
    const start = makeMessage('trace.turn.start', { turnId: 't1', userMessage: '', at: 1 })
    const step = makeMessage('trace.step.start', { turnId: 't1', stepId: 's1', index: 0, at: 2 })
    const update = makeMessage('trace.turn.update', { turnId: 't1', userMessage: '你好', at: 3 })
    hub.publish(start)
    hub.publish(step)
    hub.publish(update)
    hub.publish(start)

    const late = new FakeClient()
    hub.addClient(late)
    expect(late.received.map((raw) => JSON.parse(raw).type)).toEqual([
      'trace.turn.start',
      'trace.step.start',
    ])
    expect(JSON.parse(late.received[0] ?? '').payload.userMessage).toBe('你好')
  })

  it('trace 回放不再受旧消息数量上限影响', () => {
    const hub = createEventHub()
    for (let index = 0; index < 4_001; index += 1) {
      hub.publish(
        makeMessage('trace.turn.start', {
          turnId: `t${index}`,
          userMessage: `${index}`,
          at: index,
        }),
      )
    }
    const late = new FakeClient()
    hub.addClient(late)
    expect(late.received).toHaveLength(4_001)
    expect(JSON.parse(late.received[0] ?? '').payload.turnId).toBe('t0')
    expect(JSON.parse(late.received.at(-1) ?? '').payload.turnId).toBe('t4000')
  })

  it('trace 消息按序缓存并回放给新客户端，hasCached 供演示门控', () => {
    const hub = createEventHub()
    expect(hub.hasCached('trace.turn.start')).toBe(false)
    hub.publish(makeMessage('trace.turn.start', { turnId: 't1', userMessage: '', at: 1 }))
    hub.publish(makeMessage('trace.turn.update', { turnId: 't1', userMessage: '你好', at: 2 }))
    expect(hub.hasCached('trace.turn.start')).toBe(true)

    const late = new FakeClient()
    hub.addClient(late)
    expect(late.received.map((raw) => JSON.parse(raw).type)).toEqual(['trace.turn.start'])
  })

  it('会话级运行状态实时广播（不只缓存）', () => {
    const hub = createEventHub()
    const client = new FakeClient()
    hub.addClient(client)

    hub.publish(makeMessage('session.status', { sessionId: 'a', status: 'running' }))

    expect(JSON.parse(client.received.at(-1) ?? '').payload).toEqual({
      sessionId: 'a',
      status: 'running',
    })
  })

  it('会话状态按会话只留最新值，并作为基线回放给后连客户端', () => {
    const hub = createEventHub()
    expect(hub.hasCached('session.status')).toBe(false)
    hub.publish(makeMessage('session.status', { sessionId: 'a', status: 'running' }))
    hub.publish(makeMessage('session.status', { sessionId: 'b', status: 'running' }))
    // 同一会话的终态覆盖前值——这正是「漏掉一条终态通知就永久卡在运行中」的解药。
    hub.publish(makeMessage('session.status', { sessionId: 'a', status: 'idle' }))
    expect(hub.hasCached('session.status')).toBe(true)

    const late = new FakeClient()
    hub.addClient(late)
    const payloads = late.received
      .map(
        (raw) =>
          JSON.parse(raw) as { type: string; payload: { sessionId: string; status: string } },
      )
      .filter((message) => message.type === 'session.status')
      .map((message) => `${message.payload.sessionId}:${message.payload.status}`)

    expect(payloads.sort()).toEqual(['a:idle', 'b:running'])
  })
})
