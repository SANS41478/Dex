import type { GraphMessage } from '@dexagent/shared'
import { describe, expect, it, vi } from 'vitest'
import type { DshFiberRef, DshFiberStateValue, DshLoaderEntry } from '../dsh/contract'
import { DshFiberState } from '../dsh/contract'
import { createGraphBridge } from './graph-bridge'

function makeFiber(
  state: DshFiberStateValue,
  options: { uid?: number | null; store?: Record<string, number | null> } = {},
): DshFiberRef {
  const ref: DshFiberRef = { uid: options.uid === undefined ? 1 : options.uid, state, inject: {} }
  return options.store === undefined ? ref : { ...ref, store: options.store }
}

const provider: DshLoaderEntry = {
  id: 'sandbox-local',
  moduleName: '@deepseek-ai/dsh-sandbox-local',
  group: false,
  disabled: false,
  fiber: makeFiber(DshFiberState.ACTIVE, { uid: 7 }),
}

const consumer: DshLoaderEntry = {
  id: 'tool-fs',
  moduleName: '@deepseek-ai/dsh-tool-fs',
  group: false,
  disabled: false,
  fiber: makeFiber(DshFiberState.ACTIVE, { uid: 8, store: { 'sandbox-local': 7 } }),
}

function makeHarness(initial: DshLoaderEntry[], debounceMs = 100) {
  let entries = [...initial]
  const messages: GraphMessage[] = []
  let requestFlush: (() => void) | null = null
  let subscribeCalls = 0

  const bridge = createGraphBridge({
    readEntries: () => entries,
    subscribe: (fn) => {
      subscribeCalls += 1
      requestFlush = fn
    },
    sink: (message) => messages.push(message),
    debounceMs,
  })

  return {
    bridge,
    messages,
    subscribeCalls: () => subscribeCalls,
    setEntries(next: DshLoaderEntry[]) {
      entries = [...next]
    },
    signal() {
      requestFlush?.()
    },
  }
}

describe('createGraphBridge', () => {
  it('apply 记录基线不广播；snapshot 返回全量并可过协议校验', () => {
    const { bridge, messages } = makeHarness([provider, consumer])
    bridge.apply()
    expect(messages).toEqual([])

    expect(bridge.snapshot().type).toBe('graph.snapshot')
    expect(bridge.current().nodes.map((node) => node.id)).toEqual(['sandbox-local', 'tool-fs'])
    expect(bridge.current().links).toHaveLength(1)
  })

  it('apply 幂等：重复调用不重复订阅', () => {
    const { bridge, subscribeCalls } = makeHarness([])
    bridge.apply()
    bridge.apply()
    expect(subscribeCalls()).toBe(1)
  })

  it('事件风暴在窗口内合并为一条 upsert', () => {
    vi.useFakeTimers()
    try {
      const { bridge, messages, setEntries, signal } = makeHarness([provider])
      bridge.apply()

      setEntries([provider, { ...consumer, fiber: makeFiber(DshFiberState.ACTIVE, { uid: 8 }) }])
      signal()
      signal()
      signal()
      vi.advanceTimersByTime(99)
      expect(messages).toEqual([])

      vi.advanceTimersByTime(1)
      expect(messages).toHaveLength(1)
      const upsert = messages[0]
      if (upsert?.type !== 'graph.upsert') throw new Error('expected graph.upsert')
      expect(upsert.payload.nodes.map((node) => node.id)).toEqual(['tool-fs'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('状态变化 → upsert 节点；树无变化 → 完全静默', () => {
    vi.useFakeTimers()
    try {
      const { bridge, messages, setEntries, signal } = makeHarness([provider])
      bridge.apply()

      setEntries([{ ...provider, fiber: makeFiber(DshFiberState.FAILED, { uid: 7 }) }, consumer])
      signal()
      vi.advanceTimersByTime(100)
      expect(messages).toHaveLength(1)
      const upsert = messages[0]
      if (upsert?.type !== 'graph.upsert') throw new Error('expected graph.upsert')
      expect(upsert.payload.nodes).toEqual([
        expect.objectContaining({ id: 'sandbox-local', status: 'error' }),
        expect.objectContaining({ id: 'tool-fs' }),
      ])

      signal()
      vi.advanceTimersByTime(100)
      expect(messages).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 取消未触发的批量窗口：不再广播，低挂起事件也静默', () => {
    vi.useFakeTimers()
    try {
      const { bridge, messages, setEntries, signal } = makeHarness([provider])
      bridge.apply()

      setEntries([provider, consumer])
      signal()
      bridge.dispose()
      vi.advanceTimersByTime(100)
      expect(messages).toEqual([])

      // fiber 卸载与事件订阅注销之间的竞态：dispose 后到达的事件不得重新布防。
      signal()
      vi.advanceTimersByTime(100)
      expect(messages).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('readEntries 抛错（context 失效）时 flush 静默存活，snapshot 退回基线', () => {
    vi.useFakeTimers()
    try {
      const messages: GraphMessage[] = []
      let fail = false
      let flush: () => void = () => {}
      const bridge = createGraphBridge({
        readEntries: () => {
          if (fail) throw new Error('cannot get required service "loader" in inactive context')
          return [provider]
        },
        subscribe: (request) => {
          flush = request
        },
        sink: (message) => messages.push(message),
        debounceMs: 50,
      })
      bridge.apply()
      fail = true

      // 修复前：异常从定时器回调冒成进程级 uncaught，打死宿主（2026-10-08 实测）。
      flush()
      expect(() => vi.advanceTimersByTime(50)).not.toThrow()
      expect(messages).toEqual([])

      // 升级回调竞态：卸载后新连接取快照，同样不能抛。
      expect(() => bridge.snapshot()).not.toThrow()
      expect(bridge.snapshot().type).toBe('graph.snapshot')
      expect(bridge.current().nodes.map((node) => node.id)).toEqual(['sandbox-local'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('条目移除 → graph.remove 携带节点与关联边', () => {
    vi.useFakeTimers()
    try {
      const { bridge, messages, setEntries, signal } = makeHarness([provider, consumer])
      bridge.apply()

      setEntries([consumer])
      signal()
      vi.advanceTimersByTime(100)

      expect(messages).toHaveLength(1)
      const remove = messages[0]
      if (remove?.type !== 'graph.remove') throw new Error('expected graph.remove')
      expect(remove.payload.nodeIds).toEqual(['sandbox-local'])
      expect(remove.payload.linkIds).toEqual(['inject:tool-fs:sandbox-local'])
    } finally {
      vi.useRealTimers()
    }
  })
})
