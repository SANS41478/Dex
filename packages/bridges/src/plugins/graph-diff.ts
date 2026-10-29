import type { GraphLink, GraphNode } from '@dexagent/shared'
import type { GraphSnapshot } from './graph-map'

/** 增量补丁：命中维度才含条目；完全无变化时 `diffGraph` 返回 null（不发消息）。 */
export interface GraphPatch {
  upsert: { nodes: GraphNode[]; links: GraphLink[] }
  remove: { nodeIds: string[]; linkIds: string[] }
}

function nodeEquals(a: GraphNode, b: GraphNode): boolean {
  return (
    a.label === b.label &&
    a.type === b.type &&
    a.status === b.status &&
    a.disabled === b.disabled &&
    a.moduleName === b.moduleName &&
    a.configReadable === b.configReadable &&
    JSON.stringify(a.configKeys) === JSON.stringify(b.configKeys) &&
    JSON.stringify(a.controlCapabilities) === JSON.stringify(b.controlCapabilities)
  )
}

function linkEquals(a: GraphLink, b: GraphLink): boolean {
  return a.source === b.source && a.target === b.target && a.type === b.type
}

/** 两棵树快照 → 增量补丁（按 id 对齐，内容变化进 upsert，缺失进 remove）。 */
export function diffGraph(prev: GraphSnapshot, next: GraphSnapshot): GraphPatch | null {
  const prevNodes = new Map(prev.nodes.map((node) => [node.id, node]))
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]))
  const prevLinks = new Map(prev.links.map((link) => [link.id, link]))
  const nextLinks = new Map(next.links.map((link) => [link.id, link]))

  const nodes = next.nodes.filter((node) => {
    const before = prevNodes.get(node.id)
    return before === undefined || !nodeEquals(before, node)
  })
  const links = next.links.filter((link) => {
    const before = prevLinks.get(link.id)
    return before === undefined || !linkEquals(before, link)
  })
  const nodeIds = prev.nodes.filter((node) => !nextNodes.has(node.id)).map((node) => node.id)
  const linkIds = prev.links.filter((link) => !nextLinks.has(link.id)).map((link) => link.id)

  if (nodes.length === 0 && links.length === 0 && nodeIds.length === 0 && linkIds.length === 0) {
    return null
  }
  return { upsert: { nodes, links }, remove: { nodeIds, linkIds } }
}
