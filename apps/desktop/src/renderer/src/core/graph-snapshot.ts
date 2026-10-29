import {
  buildGraphSnapshotExport,
  type GraphNode,
  type GraphSnapshotView,
  serializeGraphSnapshotJson,
} from '@dexagent/shared'
import type { GraphLinkData, GraphNodeData } from './graph-data'

/**
 * 渲染层图谱数据 → 可导出的快照。
 *
 * **为什么映射必须收在这个函数里**：`three-forcegraph` 会把 link 的 `source` / `target`
 * 两个字段**原地替换成节点对象**（见 `graph-data.ts` 的 `GraphLinkData` 注释），而快照
 * schema 要求它们是字符串 id。原实现把渲染数据直接喂进 `buildGraphSnapshotExport`
 * （内部 `.parse()`，且调用点在 `try` 之外），于是「导出 JSON」100% 抛
 * `ZodError` 且完全没有反馈——黑盒报告 D13 记的就是这一条。
 * 把映射封在这里，调用方就没有机会再传错。
 *
 * 节点不需要重建：渲染库往节点上写的 `x/y/z/fx…` 是额外字段，zod 默认丢弃未知键。
 */
export function createGraphSnapshot(
  nodes: readonly GraphNodeData[],
  links: readonly GraphLinkData[],
  view: GraphSnapshotView,
  exportedAt = Date.now(),
) {
  const canonicalNodes: GraphNode[] = nodes.map((node) => ({ ...node }))
  const canonicalLinks = links.map((link) => ({
    id: link.id,
    type: link.type,
    // 读 `sourceId` / `targetId`：只有这两个是没有被渲染库改写的不可变事实。
    source: link.sourceId,
    target: link.targetId,
  }))
  return buildGraphSnapshotExport(canonicalNodes, canonicalLinks, view, exportedAt)
}

export { serializeGraphSnapshotJson }

/**
 * 把 `dex.snapshot.save` 的返回值翻成一句人话。
 *
 * 导出走的是主进程的 `dialog.showSaveDialog` —— **原生保存框**。在自动化里它完全不可见，
 * 因此「点了没反应」很容易被误判成功能坏了（黑盒报告 D14）；对真实用户来说反而有反馈。
 * 这里补一句应用内文案，让「取消」与「已保存」都能被看见。
 */
export function describeSnapshotSaveResult(raw: unknown): string {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  if (record?.canceled === true) return '已取消导出'
  const path = record?.path
  return typeof path === 'string' ? `已导出到 ${path}` : '已导出'
}
