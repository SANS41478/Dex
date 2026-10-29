import { type GraphMessage, makeMessage } from '@dexagent/shared'
import type { DshLoaderEntry } from '../dsh/contract'
import { createDebouncedBatch } from './debounce'
import { diffGraph } from './graph-diff'
import { buildGraph, type GraphSnapshot } from './graph-map'

/** 固定窗口批量：dsh HMR 一次改动可产生 200+ 事件（实测）。 */
export const GRAPH_BRIDGE_DEBOUNCE_MS = 120

export interface GraphBridgeOptions {
  /** 读取当前插件树（契约类型；由 host 层从官方对象适配）。 */
  readonly readEntries: () => Iterable<DshLoaderEntry>
  /** 订阅整树事件：事件到达即调用 `requestFlush`；host 层负责 `{ global: true }` 订阅。 */
  readonly subscribe: (requestFlush: () => void) => void
  /** 协议消息出口：host/entry 接到 webserver 路由广播。 */
  readonly sink: (message: GraphMessage) => void
  /** 批量窗口（毫秒），默认 {@link GRAPH_BRIDGE_DEBOUNCE_MS}。 */
  readonly debounceMs?: number
}

export interface GraphBridge {
  /** 挂载：记录基线（不广播）+ 开始订阅。 */
  readonly apply: () => void
  /** 当前插件树的全量快照消息（新连接建立时发送）。 */
  readonly snapshot: () => GraphMessage
  /** 当前树快照（测试/宿主诊断用）。 */
  readonly current: () => GraphSnapshot
  /** 卸载：取消未触发的批量窗口，并让后续事件与读取全部静默失效。 */
  readonly dispose: () => void
}

export function createGraphBridge(options: GraphBridgeOptions): GraphBridge {
  const debounceMs = options.debounceMs ?? GRAPH_BRIDGE_DEBOUNCE_MS

  let previous: GraphSnapshot = { nodes: [], links: [] }
  let started = false
  let disposed = false

  /**
   * 读取当前树；宿主 context 已失效（fiber 卸载 / 进程收尾）时读取会抛
   * 「cannot get required service ... in inactive context」。
   *
   * 为什么必须就地兜底：该读取发生在定时器回调与 ws 升级回调里，没有调用方
   * 能接住异常——2026-10-08 实测它曾以 `fatal uncaught exception` 打死整个
   * dsh 宿主（`dex-graph-bridge` 的防抖窗口在插件卸载后触发）。
   */
  const read = (): GraphSnapshot | null => {
    if (disposed) return null
    try {
      return buildGraph(options.readEntries())
    } catch {
      return null
    }
  }

  const flush = (): void => {
    const next = read()
    if (next === null) return
    const patch = diffGraph(previous, next)
    previous = next
    if (patch === null) return

    if (patch.upsert.nodes.length > 0 || patch.upsert.links.length > 0) {
      options.sink(makeMessage('graph.upsert', patch.upsert))
    }
    if (patch.remove.nodeIds.length > 0 || patch.remove.linkIds.length > 0) {
      options.sink(makeMessage('graph.remove', patch.remove))
    }
  }

  const batch = createDebouncedBatch(flush, debounceMs)

  return {
    apply() {
      if (started) return
      started = true
      // 基线：安装时已有条目不广播，新连接走 snapshot（避免向 0 客户端发整树 upsert）。
      // 基线读取失败（context 未就绪/已失效）时保持空基线，后续 flush 不广播。
      previous = read() ?? previous
      options.subscribe(() => {
        if (disposed) return
        batch.schedule()
      })
    },
    // 卸载后仍可能有升级回调竞态抵达：退回最后一份快照，而不是抛异常。
    snapshot: () => makeMessage('graph.snapshot', read() ?? previous),
    current: () => previous,
    dispose() {
      disposed = true
      batch.cancel()
    },
  }
}
