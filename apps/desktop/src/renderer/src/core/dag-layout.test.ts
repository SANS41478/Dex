import { describe, expect, it } from 'vitest'
import { buildDagFromTurns } from './dag-graph'
import { DAG_NODE_SIZES, fallbackLayout, layoutDag, sizeOf } from './dag-layout'
import type { TurnRecord } from './trace'

function makeGraph() {
  const turn: TurnRecord = {
    id: 'turn-1',
    userMessage: '看看项目结构',
    status: 'completed',
    startedAt: 1,
    steps: [
      {
        id: 'turn-1-step-1',
        turnId: 'turn-1',
        index: 0,
        llmReasoning: '先读 README',
        status: 'success',
        startedAt: 1,
        toolCalls: [
          {
            id: 'turn-1-tool-1',
            stepId: 'turn-1-step-1',
            toolName: 'read_file',
            pluginId: 'plugin-tool-fs',
            input: {},
            status: 'success',
            startedAt: 1,
          },
        ],
      },
    ],
  }
  return buildDagFromTurns([turn])
}

describe('layoutDag（ELK）', () => {
  it('为每个节点分配有限坐标且尺寸正确，节点/边数守恒', async () => {
    const graph = makeGraph()
    const result = await layoutDag(graph)

    expect(result.nodes).toHaveLength(graph.nodes.length)
    expect(result.edges).toHaveLength(graph.edges.length)
    for (const node of result.nodes) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
      expect(node.width).toBe(DAG_NODE_SIZES[node.kind].width)
      expect(node.height).toBe(DAG_NODE_SIZES[node.kind].height)
    }
    // 分层布局：tool 应排在 step 之后（x 更大）
    const tool = result.nodes.find((node) => node.kind === 'tool')
    const step = result.nodes.find((node) => node.kind === 'step')
    if (tool === undefined || step === undefined) throw new Error('expected nodes')
    expect(tool.x).toBeGreaterThan(step.x)
  })

  it('同输入结果确定（可复现）', async () => {
    const graph = makeGraph()
    const [a, b] = await Promise.all([layoutDag(graph), layoutDag(graph)])
    expect(a.nodes.map((node) => `${node.id}:${node.x},${node.y}`)).toEqual(
      b.nodes.map((node) => `${node.id}:${node.x},${node.y}`),
    )
  })

  it('空图返回空结果', async () => {
    const result = await layoutDag(buildDagFromTurns([]))
    expect(result).toEqual({ nodes: [], edges: [] })
  })
})

describe('fallbackLayout', () => {
  it('按类别分列兜底，坐标有限', () => {
    const graph = makeGraph()
    const nodes = fallbackLayout(graph)
    expect(nodes).toHaveLength(graph.nodes.length)
    const turn = nodes.find((node) => node.kind === 'turn')
    const tool = nodes.find((node) => node.kind === 'tool')
    if (turn === undefined || tool === undefined) throw new Error('expected nodes')
    expect(tool.x).toBeGreaterThan(turn.x)
  })
})

describe('sizeOf（展开尺寸）', () => {
  it('展开的 step 节点尺寸随 chip 行数增大；其它类别与未展开时不变', () => {
    const collapsed = sizeOf('step', { toolCount: 3 })
    const expanded = sizeOf('step', { expanded: true, toolCount: 3 })
    expect(expanded.width).toBeGreaterThan(collapsed.width)
    expect(expanded.height).toBeGreaterThan(collapsed.height)

    expect(sizeOf('tool', { expanded: true, toolCount: 3 })).toEqual(DAG_NODE_SIZES.tool)
    expect(sizeOf('step', { expanded: true, toolCount: 0 })).toEqual(DAG_NODE_SIZES.step)
    expect(sizeOf('step', { toolCount: 0 })).toEqual(DAG_NODE_SIZES.step)
  })

  it('layoutDag 按 expandedId 分配更大尺寸', async () => {
    const graph = makeGraph()
    const collapsed = await layoutDag(graph)
    const expanded = await layoutDag(graph, { expandedId: 'turn-1-step-1' })
    const collapsedStep = collapsed.nodes.find((node) => node.kind === 'step')
    const expandedStep = expanded.nodes.find((node) => node.kind === 'step')
    if (collapsedStep === undefined || expandedStep === undefined) throw new Error('expected step')
    expect(expandedStep.width).toBeGreaterThan(collapsedStep.width)
    expect(expandedStep.height).toBeGreaterThan(collapsedStep.height)
  })
})
