import { describe, expect, it } from 'vitest'
import { buildDagFromTurns, effectiveStepTone, effectiveTurnTone, statusTone } from './dag-graph'
import type { StepRecord, ToolCallRecord, TurnRecord } from './trace'

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 'turn-1',
    userMessage: '看看项目结构',
    status: 'running',
    startedAt: 1,
    steps: [],
    ...overrides,
  }
}

describe('statusTone', () => {
  it('归一化各域状态到四态色调', () => {
    expect(statusTone('running')).toBe('running')
    expect(statusTone('success')).toBe('ok')
    expect(statusTone('completed')).toBe('ok')
    expect(statusTone('failed')).toBe('error')
    expect(statusTone('pending')).toBe('pending')
    expect(statusTone('whatever')).toBe('pending')
  })
})

describe('失败传播（effective tones）', () => {
  const failedTool: ToolCallRecord = {
    id: 'c1',
    stepId: 's1',
    toolName: 'edit',
    pluginId: 'include:tool-fs',
    input: {},
    status: 'failed',
    startedAt: 2,
  }
  const failingStep: StepRecord = {
    id: 's1',
    turnId: 't1',
    index: 0,
    llmReasoning: '写入被拒',
    status: 'success',
    startedAt: 1,
    toolCalls: [failedTool],
  }
  const cleanStep: StepRecord = { ...failingStep, id: 's2', toolCalls: [] }

  it('工具失败 → Step 红（即使 step 自身 success）；Step 红 → Turn 红（即使 turn completed）', () => {
    expect(effectiveStepTone(failingStep)).toBe('error')
    expect(effectiveStepTone(cleanStep)).toBe('ok')

    const turn: TurnRecord = {
      id: 't1',
      userMessage: '看看',
      status: 'completed',
      startedAt: 1,
      endedAt: 3,
      steps: [failingStep, cleanStep],
    }
    expect(effectiveTurnTone(turn)).toBe('error')
  })

  it('无失败时保持自身色调（running 不被传播改变）', () => {
    const running: TurnRecord = {
      id: 't1',
      userMessage: '',
      status: 'running',
      startedAt: 1,
      steps: [{ ...cleanStep, status: 'running' }],
    }
    expect(effectiveTurnTone(running)).toBe('running')
    expect(effectiveStepTone({ ...cleanStep, status: 'running' })).toBe('running')
  })

  it('建图时 turn/step 节点使用传播后的色调，step 携带工具 chips', () => {
    const graph = buildDagFromTurns([
      {
        id: 't1',
        userMessage: '看看',
        status: 'completed',
        startedAt: 1,
        endedAt: 3,
        steps: [failingStep],
      },
    ])
    expect(graph.nodes.find((node) => node.kind === 'turn')?.status).toBe('error')
    const stepNode = graph.nodes.find((node) => node.kind === 'step')
    expect(stepNode?.status).toBe('error')
    expect(stepNode?.tools).toEqual([{ label: 'edit', tone: 'error' }])
  })
})

describe('buildDagFromTurns', () => {
  it('turn → step → tool 建图，step 间有顺序边，tool 带 pluginId', () => {
    const graph = buildDagFromTurns([
      makeTurn({
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
                durationMs: 418,
              },
            ],
          },
          {
            id: 'turn-1-step-2',
            turnId: 'turn-1',
            index: 1,
            llmReasoning: '定位可疑点',
            status: 'running',
            startedAt: 2,
            toolCalls: [],
          },
        ],
      }),
    ])

    expect(graph.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual([
      'turn:turn-1',
      'step:turn-1-step-1',
      'tool:turn-1-tool-1',
      'step:turn-1-step-2',
    ])

    const edgeKinds = graph.edges.map((edge) => edge.kind)
    expect(edgeKinds).toEqual(['turn-step', 'step-tool', 'turn-step', 'step-step'])

    const tool = graph.nodes.find((node) => node.kind === 'tool')
    expect(tool).toEqual(
      expect.objectContaining({ label: 'read_file', pluginId: 'plugin-tool-fs', durationMs: 418 }),
    )
    expect(graph.nodes.find((node) => node.id === 'turn-1-step-2')?.status).toBe('running')
  })

  it('结构签名只看节点/边，内容签名随状态变化；空输入稳定', () => {
    const empty = buildDagFromTurns([])
    expect(empty.nodes).toEqual([])
    expect(empty.edges).toEqual([])

    const base = buildDagFromTurns([makeTurn()])
    const same = buildDagFromTurns([makeTurn()])
    expect(base.structuralKey).toBe(same.structuralKey)
    expect(base.contentKey).toBe(same.contentKey)

    const changed = buildDagFromTurns([makeTurn({ status: 'completed' })])
    expect(changed.structuralKey).toBe(base.structuralKey)
    expect(changed.contentKey).not.toBe(base.contentKey)
  })
})
