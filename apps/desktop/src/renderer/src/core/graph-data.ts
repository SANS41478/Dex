import type { GraphLink, GraphNode } from '@dexagent/shared'

/** force-graph 会在运行时往节点上写坐标/速度字段；这些字段必须跨更新保留（布局稳定）。 */
export interface GraphNodeData extends GraphNode {
  x?: number
  y?: number
  z?: number
  fx?: number
  fy?: number
  fz?: number
}

/**
 * 渲染层 link。
 *
 * `sourceId`/`targetId` 是**不可变事实**：我们所有逻辑（过滤、子图、度数、详情）都读它们。
 * `source`/`target` 是**渲染库的 scratch 字段**：`three-forcegraph` 会把它们替换成节点对象
 * （并交给 d3-force 写 vx/vy/vz），我们 MUST NOT 依赖或回写它们（M1-08 修复）。
 */
export interface GraphLinkData {
  id: string
  type: GraphLink['type']
  sourceId: string
  targetId: string
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNodeData[]
  links: GraphLinkData[]
}

export function createGraphData(): GraphData {
  return { nodes: [], links: [] }
}

export function toRenderLink(link: GraphLink): GraphLinkData {
  return {
    id: link.id,
    type: link.type,
    sourceId: link.source,
    targetId: link.target,
    source: link.source,
    target: link.target,
  }
}

export interface GraphUpdateInput {
  readonly nodes: readonly GraphNode[]
  readonly links: readonly GraphLink[]
}

export interface GraphUpdateResult {
  /** 节点/边的增删（或边端点变化）：需要更换 graphData 身份并重排。 */
  readonly structural: boolean
  /** 展示字段（label/type/status）变化：原地更新即可，不需要重排。 */
  readonly content: boolean
}

/**
 * 增量合并（**节点对象**引用稳定以保坐标；**数组**在结构性变化时换新引用以保引擎安全）：
 * 已存在的节点只更新展示字段；新增节点入数组；消失节点移除并剪掉悬空边。
 * 边只比较 `sourceId/targetId`，绝不读写渲染库的 scratch `source/target`。
 *
 * 为什么数组要换新引用（2026-10-08，UI-10 实测）：d3 引擎持有 `links`/`nodes`
 * **数组引用**。原地 splice/push 会让运行中的 tick 读到尚未被渲染库重解析的新 link
 * 对象（scratch 还是 `sourceId/targetId` 字符串），抛
 * `Cannot create property 'vx' on string ...`（插件启停的 reconcile 首次触发运行期
 * 删边时必现）。结构性变化改为「拷贝数组、旧数组不再触碰」，引擎在 digest 前的
 * 最后几帧仍持有旧数组的一致性视图。
 */
export function applyGraphUpdate(current: GraphData, next: GraphUpdateInput): GraphUpdateResult {
  let structural = false
  let content = false

  const nodeById = new Map(current.nodes.map((node) => [node.id, node]))
  const nextNodeIds = new Set(next.nodes.map((node) => node.id))
  const keptNodes: GraphNodeData[] = []

  for (const incoming of next.nodes) {
    const existing = nodeById.get(incoming.id)
    if (existing === undefined) {
      const added: GraphNodeData = { ...incoming }
      keptNodes.push(added)
      nodeById.set(incoming.id, added)
      structural = true
      continue
    }
    keptNodes.push(existing)
    if (
      existing.label !== incoming.label ||
      existing.type !== incoming.type ||
      existing.status !== incoming.status ||
      existing.moduleName !== incoming.moduleName ||
      existing.disabled !== incoming.disabled ||
      existing.configReadable !== incoming.configReadable ||
      JSON.stringify(existing.configKeys) !== JSON.stringify(incoming.configKeys) ||
      JSON.stringify(existing.controlCapabilities) !== JSON.stringify(incoming.controlCapabilities)
    ) {
      existing.label = incoming.label
      existing.type = incoming.type
      existing.status = incoming.status
      if (incoming.disabled === undefined) delete existing.disabled
      else existing.disabled = incoming.disabled
      if (incoming.moduleName === undefined) delete existing.moduleName
      else existing.moduleName = incoming.moduleName
      if (incoming.configReadable === undefined) delete existing.configReadable
      else existing.configReadable = incoming.configReadable
      if (incoming.configKeys === undefined) delete existing.configKeys
      else existing.configKeys = [...incoming.configKeys]
      if (incoming.controlCapabilities === undefined) delete existing.controlCapabilities
      else existing.controlCapabilities = incoming.controlCapabilities
      content = true
    }
  }

  if (current.nodes.length !== keptNodes.length) structural = true
  else if (current.nodes.some((node, index) => node !== keptNodes[index])) structural = true
  if (structural) current.nodes = keptNodes

  const linkById = new Map(current.links.map((link) => [link.id, link]))
  const keptLinks: GraphLinkData[] = []

  for (const incoming of next.links) {
    if (!nextNodeIds.has(incoming.source) || !nextNodeIds.has(incoming.target)) continue
    const existing = linkById.get(incoming.id)
    if (existing === undefined) {
      keptLinks.push(toRenderLink(incoming))
      structural = true
      continue
    }
    keptLinks.push(existing)
    if (existing.sourceId !== incoming.source || existing.targetId !== incoming.target) {
      existing.sourceId = incoming.source
      existing.targetId = incoming.target
      // 端点变化时把 scratch 归零为 id 字符串，让渲染库重新解析
      existing.source = incoming.source
      existing.target = incoming.target
      structural = true
    } else if (existing.type !== incoming.type) {
      existing.type = incoming.type
      content = true
    }
  }

  if (current.links.length !== keptLinks.length) structural = true
  else if (current.links.some((link, index) => link !== keptLinks[index])) structural = true
  if (structural) current.links = keptLinks

  return { structural, content }
}

/** 固定已落位的节点（fx/fy/fz = 当前坐标）；未落位（无坐标）的节点保持自由。 */
export function pinSettledNodes(data: GraphData): number {
  let pinned = 0
  for (const node of data.nodes) {
    if (node.fx !== undefined) continue
    if (node.x === undefined || node.y === undefined || node.z === undefined) continue
    node.fx = node.x
    node.fy = node.y
    node.fz = node.z
    pinned += 1
  }
  return pinned
}

/** 释放全部节点的固定态（拖拽期间临时解 pin，让邻居/边受力跟随）。 */
export function releasePins(data: GraphData): number {
  let released = 0
  for (const node of data.nodes) {
    if (node.fx === undefined && node.fy === undefined && node.fz === undefined) continue
    delete node.fx
    delete node.fy
    delete node.fz
    released += 1
  }
  return released
}
