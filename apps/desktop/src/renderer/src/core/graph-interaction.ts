import type { GraphLink, GraphNode, PluginType } from '@dexagent/shared'
import { z } from 'zod'

/**
 * 取 link 的端点 id：优先不可变 `sourceId/targetId`（渲染层 link），
 * 其次字符串 `source/target`（协议侧）；端点被渲染库替换成对象且无 id 字段时返回 null。
 * 所有纯函数 MUST 经这里读端点，MUST NOT 直接读 `source/target`（见 graph-data.ts 注释）。
 */
export function linkEnds(link: GraphLink): { sourceId: string; targetId: string } | null {
  const raw = link as unknown as {
    sourceId?: unknown
    targetId?: unknown
    source?: unknown
    target?: unknown
  }
  const sourceId =
    typeof raw.sourceId === 'string'
      ? raw.sourceId
      : typeof raw.source === 'string'
        ? raw.source
        : null
  const targetId =
    typeof raw.targetId === 'string'
      ? raw.targetId
      : typeof raw.target === 'string'
        ? raw.target
        : null
  return sourceId === null || targetId === null ? null : { sourceId, targetId }
}

/** 搜索匹配：label / id / 完整模块名 的大小写不敏感子串。 */
export function matchesQuery(node: GraphNode, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (normalized === '') return false
  return (
    node.label.toLowerCase().includes(normalized) ||
    node.id.toLowerCase().includes(normalized) ||
    (node.moduleName?.toLowerCase().includes(normalized) ?? false)
  )
}

/**
 * 类型过滤（隐藏式）：剔除不可见类型的节点与悬空边。
 * 节点对象**按引用透传**（保留 force-graph 写回的坐标与固定态），恢复过滤即回原位。
 */
export function filterGraph<T extends GraphNode>(
  nodes: readonly T[],
  links: readonly GraphLink[],
  visibleTypes: ReadonlySet<PluginType>,
): { nodes: T[]; links: GraphLink[] } {
  const visible: T[] = []
  const visibleIds = new Set<string>()
  for (const node of nodes) {
    if (visibleTypes.has(node.type)) {
      visible.push(node)
      visibleIds.add(node.id)
    }
  }
  const keptLinks = links.filter((link) => {
    const ends = linkEnds(link)
    return ends !== null && visibleIds.has(ends.sourceId) && visibleIds.has(ends.targetId)
  })
  return { nodes: visible, links: keptLinks }
}

/** inject 度数（入 + 出），节点尺寸编码用。 */
export function computeDegrees(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
): Map<string, number> {
  const degrees = new Map<string, number>()
  for (const node of nodes) degrees.set(node.id, 0)
  for (const link of links) {
    const ends = linkEnds(link)
    if (ends === null) continue
    if (degrees.has(ends.sourceId)) {
      degrees.set(ends.sourceId, (degrees.get(ends.sourceId) ?? 0) + 1)
    }
    if (degrees.has(ends.targetId)) {
      degrees.set(ends.targetId, (degrees.get(ends.targetId) ?? 0) + 1)
    }
  }
  return degrees
}

/** 各类型的节点总数（过滤 chips 的计数）。 */
export function countTypes(nodes: readonly GraphNode[]): Record<PluginType, number> {
  const counts: Record<PluginType, number> = {
    model: 0,
    tool: 0,
    skill: 0,
    scheduler: 0,
    sandbox: 0,
    other: 0,
  }
  for (const node of nodes) counts[node.type] += 1
  return counts
}

/** 与选中节点直接相连的邻居集合。 */
export function neighborsOf(nodeId: string, links: readonly GraphLink[]): Set<string> {
  const neighbors = new Set<string>()
  for (const link of links) {
    const ends = linkEnds(link)
    if (ends === null) continue
    if (ends.sourceId === nodeId) neighbors.add(ends.targetId)
    else if (ends.targetId === nodeId) neighbors.add(ends.sourceId)
  }
  return neighbors
}

/**
 * 聚焦子图：从根节点出发、沿无向边 BFS `hops` 跳可达的节点集合（含根）。
 * 根不在节点集合中时返回空集；孤立节点返回只含根自身的集合。
 */
export function subgraphOf(
  rootId: string,
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
  hops = 1,
): Set<string> {
  if (!nodes.some((node) => node.id === rootId)) return new Set()

  const adjacency = new Map<string, Set<string>>()
  const connect = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    adjacency.get(a)?.add(b)
  }
  for (const link of links) {
    const ends = linkEnds(link)
    if (ends === null) continue
    connect(ends.sourceId, ends.targetId)
    connect(ends.targetId, ends.sourceId)
  }

  const visited = new Set<string>([rootId])
  let frontier = [rootId]
  for (let depth = 0; depth < hops && frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const current of frontier) {
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return visited
}

export interface EdgeSummary {
  readonly linkId: string
  readonly nodeId: string
  readonly label: string
  readonly moduleName: string | null
}

/** 详情面板用：把某节点的入/出边整理为可渲染摘要（业务计算留在 core）。 */
export function edgeSummaries(
  nodeId: string,
  links: readonly GraphLink[],
  nodesById: ReadonlyMap<string, GraphNode>,
): { incoming: EdgeSummary[]; outgoing: EdgeSummary[] } {
  const incoming: EdgeSummary[] = []
  const outgoing: EdgeSummary[] = []
  for (const link of links) {
    const ends = linkEnds(link)
    if (ends === null) continue
    if (ends.sourceId === nodeId) {
      const target = nodesById.get(ends.targetId)
      if (target !== undefined) outgoing.push(summaryOf(link.id, target))
    } else if (ends.targetId === nodeId) {
      const source = nodesById.get(ends.sourceId)
      if (source !== undefined) incoming.push(summaryOf(link.id, source))
    }
  }
  return { incoming, outgoing }
}

function summaryOf(linkId: string, node: GraphNode): EdgeSummary {
  return {
    linkId,
    nodeId: node.id,
    label: node.label,
    moduleName: node.moduleName ?? null,
  }
}

const vectorSchema = z.object({ x: z.number(), y: z.number(), z: z.number() })

export const cameraViewSchema = z.object({
  position: vectorSchema,
  lookAt: vectorSchema,
})
export type CameraView = z.infer<typeof cameraViewSchema>

export function serializeCameraView(view: CameraView): string {
  return JSON.stringify(view)
}

/** localStorage 读回相机状态：损坏/缺字段一律视为无记录（不抛异常）。 */
export function parseCameraView(raw: string | null | undefined): CameraView | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = cameraViewSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
