import { isGraphMessage, isTraceMessage, makeMessage } from '@dexagent/shared'
import { describe, expect, it, vi } from 'vitest'
import { type BridgeSocket, createBridgeChannel } from './bridge-channel'

class FakeSocket implements BridgeSocket {
  readyState = 1
  closed = false
  private readonly listeners = {
    open: [] as (() => void)[],
    message: [] as ((data: unknown) => void)[],
    close: [] as (() => void)[],
    error: [] as ((error: Error) => void)[],
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  on(event: 'open' | 'message' | 'close' | 'error', listener: never): unknown {
    if (event === 'open') this.listeners.open.push(listener as () => void)
    if (event === 'message') this.listeners.message.push(listener as (data: unknown) => void)
    if (event === 'close') this.listeners.close.push(listener as () => void)
    if (event === 'error') this.listeners.error.push(listener as (error: Error) => void)
    return this
  }

  emitOpen(): void {
    for (const listener of [...this.listeners.open]) listener()
  }

  emitMessage(data: unknown): void {
    for (const listener of [...this.listeners.message]) listener(data)
  }

  emitClose(): void {
    for (const listener of [...this.listeners.close]) listener()
  }
}

describe('createBridgeChannel', () => {
  it('只转发 accept 通过的消息类型，忽略非法帧（图谱通道）', () => {
    const socket = new FakeSocket()
    const received: string[] = []
    const channel = createBridgeChannel({
      url: 'ws://127.0.0.1:4320/dex-graph',
      accept: isGraphMessage,
      onMessage: (message) => received.push(message.type),
      socketFactory: () => socket,
    })

    socket.emitOpen()
    expect(channel.isConnected()).toBe(true)

    socket.emitMessage(JSON.stringify(makeMessage('graph.snapshot', { nodes: [], links: [] })))
    socket.emitMessage(JSON.stringify(makeMessage('graph.upsert', { nodes: [], links: [] })))
    socket.emitMessage('not json')
    socket.emitMessage(JSON.stringify({ v: 1, type: 'graph.snapshot', ts: 1, payload: {} }))
    socket.emitMessage(
      JSON.stringify(makeMessage('trace.turn.start', { turnId: 't', userMessage: 'x', at: 1 })),
    )

    expect(received).toEqual(['graph.snapshot', 'graph.upsert'])
  })

  it('trace 通道只转发 trace 消息', () => {
    const socket = new FakeSocket()
    const received: string[] = []
    createBridgeChannel({
      url: 'ws://127.0.0.1:4320/dex-trace',
      accept: isTraceMessage,
      onMessage: (message) => received.push(message.type),
      socketFactory: () => socket,
    })

    socket.emitMessage(
      JSON.stringify(makeMessage('trace.turn.start', { turnId: 't', userMessage: 'x', at: 1 })),
    )
    socket.emitMessage(JSON.stringify(makeMessage('graph.remove', { nodeIds: [], linkIds: [] })))
    socket.emitMessage(
      JSON.stringify(makeMessage('trace.turn.update', { turnId: 't', userMessage: 'y', at: 2 })),
    )
    expect(received).toEqual(['trace.turn.start', 'trace.turn.update'])
  })

  it('断线后按退避重连，stop 后不再重连', () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const channel = createBridgeChannel({
        url: 'ws://127.0.0.1:4320/dex-graph',
        accept: isGraphMessage,
        onMessage: () => {},
        reconnectDelaysMs: [100, 200],
        socketFactory: () => {
          const socket = new FakeSocket()
          sockets.push(socket)
          return socket
        },
      })

      expect(sockets).toHaveLength(1)
      sockets[0]?.emitClose()
      vi.advanceTimersByTime(99)
      expect(sockets).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(2)

      channel.stop()
      sockets[1]?.emitClose()
      vi.advanceTimersByTime(10_000)
      expect(sockets).toHaveLength(2)
      expect(channel.isConnected()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
