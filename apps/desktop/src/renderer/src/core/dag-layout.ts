// 用 bundled 入口：`elkjs` 主入口会 require 可选的 `web-worker`（仅 Worker 模式需要），
// 打包器无法解析该可选依赖；bundled 版内联了 worker 实现，浏览器/Node 都可直接跑。
import ELK from 'elkjs/lib/elk.bundled.js'
import type { DagEdge, DagGraph, DagNode, DagNodeKind } from './dag-graph'

export interface PositionedDagNode extends DagNode {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DagLayoutResult {
  readonly nodes: PositionedDagNode[]
  readonly edges: DagEdge[]
}

export interface DagLayoutSize {
  readonly width: number
  readonly height: number
}

/** 按节点类别定尺寸：turn 最宽（承载用户输入），tool 最小。 */
export const DAG_NODE_SIZES: Record<DagNodeKind, DagLayoutSize> = {
  turn: { width: 216, height: 64 },
  step: { width: 184, height: 56 },
  tool: { width: 148, height: 40 },
}

/** 展开的 step 节点：chips 两列一行；超过 6 个只加一行「+N」提示；有思考再加一行。 */
const EXPANDED_STEP_WIDTH = 236
const CHIP_ROW_HEIGHT = 22
const THOUGHT_ROW_HEIGHT = 22
const MAX_VISIBLE_CHIPS = 6

export interface DagNodeSizeOptions {
  readonly expanded?: boolean
  readonly toolCount?: number
  /** 展开态是否还有「思考」一行（模型思考首句摘要）。 */
  readonly hasThought?: boolean
}

export function sizeOf(kind: DagNodeKind, options: DagNodeSizeOptions = {}): DagLayoutSize {
  const base = DAG_NODE_SIZES[kind]
  if (options.expanded !== true || kind !== 'step') return base
  const toolCount = options.toolCount ?? 0
  const visible = Math.min(toolCount, MAX_VISIBLE_CHIPS)
  const rows = visible === 0 ? 0 : Math.ceil(visible / 2)
  const thoughtHeight = options.hasThought === true ? THOUGHT_ROW_HEIGHT : 0
  if (rows === 0 && thoughtHeight === 0) return base
  return {
    width: EXPANDED_STEP_WIDTH,
    height: base.height + 10 + rows * CHIP_ROW_HEIGHT + thoughtHeight,
  }
}

function sizeForNode(node: DagNode, expandedId: string | null): DagLayoutSize {
  return sizeOf(node.kind, {
    expanded: node.id === expandedId,
    toolCount: node.tools?.length ?? 0,
    hasThought: node.thought !== undefined,
  })
}

const elk = new ELK()

/** ELK 失败时的兜底：按类别分列 + 顺序纵排（保证仍可渲染）。 */
export function fallbackLayout(
  graph: DagGraph,
  expandedId: string | null = null,
): PositionedDagNode[] {
  const columns: Record<DagNodeKind, number> = { turn: 0, step: 1, tool: 2 }
  const counters: Record<DagNodeKind, number> = { turn: 0, step: 0, tool: 0 }
  return graph.nodes.map((node) => {
    const size = sizeForNode(node, expandedId)
    const index = counters[node.kind]
    counters[node.kind] = index + 1
    return {
      ...node,
      ...size,
      x: columns[node.kind] * 260,
      y: index * 72,
    }
  })
}

export interface DagLayoutOptions {
  readonly direction?: 'RIGHT' | 'DOWN'
  /** 展开的 step 节点 id（尺寸变化触发重排）。 */
  readonly expandedId?: string | null
}

/** ELK 分层布局（layered）；空图直接返回；异常回退到固定列布局。 */
export async function layoutDag(
  graph: DagGraph,
  options: DagLayoutOptions = {},
): Promise<DagLayoutResult> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] }
  const direction = options.direction ?? 'RIGHT'
  const expandedId = options.expandedId ?? null

  try {
    const result = await elk.layout({
      id: 'dex-dag',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': direction,
        'elk.spacing.nodeNode': '24',
        'elk.layered.spacing.nodeNodeBetweenLayers': '64',
        'elk.edgeRouting': 'ORTHOGONAL',
      },
      children: graph.nodes.map((node) => ({ id: node.id, ...sizeForNode(node, expandedId) })),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    })

    const positions = new Map<string, { x: number; y: number }>()
    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
    }

    return {
      nodes: graph.nodes.map((node) => {
        const size = sizeForNode(node, expandedId)
        const position = positions.get(node.id) ?? { x: 0, y: 0 }
        return { ...node, ...size, x: position.x, y: position.y }
      }),
      edges: graph.edges,
    }
  } catch {
    return { nodes: fallbackLayout(graph, expandedId), edges: graph.edges }
  }
}
