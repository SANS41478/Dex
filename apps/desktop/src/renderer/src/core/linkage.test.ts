import { describe, expect, it } from 'vitest'
import {
  filterTurnsByPlugin,
  findTraceSelection,
  pluginsOfSelection,
  stepUsesPlugin,
} from './linkage'
import type { StepRecord, ToolCallRecord, TurnRecord } from './trace'

function tool(partial: Partial<ToolCallRecord> & { id: string; pluginId: string }): ToolCallRecord {
  return {
    stepId: 's1',
    toolName: 'read',
    input: {},
    status: 'success',
    startedAt: 1,
    ...partial,
  }
}

function step(
  partial: Partial<StepRecord> & { id: string; toolCalls: ToolCallRecord[] },
): StepRecord {
  return {
    turnId: 't1',
    index: 0,
    llmReasoning: '',
    status: 'success',
    startedAt: 1,
    ...partial,
  }
}

function turn(partial: Partial<TurnRecord> & { id: string; steps: StepRecord[] }): TurnRecord {
  return { userMessage: '看看', status: 'completed', startedAt: 1, ...partial }
}

const turns: TurnRecord[] = [
  turn({
    id: 't1',
    steps: [
      step({
        id: 's1',
        toolCalls: [
          tool({ id: 'c1', pluginId: 'include:tool-fs' }),
          tool({ id: 'c2', pluginId: 'unknown' }),
        ],
      }),
      step({ id: 's2', toolCalls: [tool({ id: 'c3', pluginId: 'include:tool-search' })] }),
    ],
  }),
  turn({ id: 't2', status: 'running', steps: [step({ id: 's3', toolCalls: [] })] }),
]

describe('findTraceSelection', () => {
  it('按 id 定位 turn / step / tool，找不到返回 null', () => {
    expect(findTraceSelection('t1', turns)?.kind).toBe('turn')
    const s1 = findTraceSelection('s1', turns)
    expect(s1?.kind).toBe('step')
    expect(s1?.step?.id).toBe('s1')
    const c1 = findTraceSelection('c1', turns)
    expect(c1?.kind).toBe('tool')
    expect(c1?.tool?.toolName).toBe('read')
    expect(c1?.step?.id).toBe('s1')
    expect(findTraceSelection('missing', turns)).toBeNull()
    expect(findTraceSelection(null, turns)).toBeNull()
  })
})

describe('pluginsOfSelection', () => {
  it('step 取全部工具插件并去重、忽略 unknown', () => {
    expect(pluginsOfSelection(findTraceSelection('s1', turns))).toEqual(['include:tool-fs'])
    expect(pluginsOfSelection(findTraceSelection('c2', turns))).toEqual([])
  })

  it('tool 取自身插件；turn 取全turn 插件并去重', () => {
    expect(pluginsOfSelection(findTraceSelection('c3', turns))).toEqual(['include:tool-search'])
    expect(pluginsOfSelection(findTraceSelection('t1', turns))).toEqual([
      'include:tool-fs',
      'include:tool-search',
    ])
    expect(pluginsOfSelection(null)).toEqual([])
  })
})

describe('filterTurnsByPlugin', () => {
  it('保留匹配 Step 与其工具，丢弃无匹配的 turn；null 原样返回同引用', () => {
    const filtered = filterTurnsByPlugin(turns, 'include:tool-fs')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.id).toBe('t1')
    expect(filtered[0]?.steps.map((item) => item.id)).toEqual(['s1'])
    // 匹配 Step 的全部工具保留（含 unknown 工具）
    expect(filtered[0]?.steps[0]?.toolCalls.map((item) => item.id)).toEqual(['c1', 'c2'])

    const search = filterTurnsByPlugin(turns, 'include:tool-search')
    expect(search[0]?.steps.map((item) => item.id)).toEqual(['s2'])

    expect(filterTurnsByPlugin(turns, null)).toBe(turns)
    expect(filterTurnsByPlugin(turns, 'nope')).toEqual([])
  })

  it('stepUsesPlugin 判定单步', () => {
    const s1 = turns[0]?.steps[0]
    if (s1 === undefined) throw new Error('expected step')
    expect(stepUsesPlugin(s1, 'include:tool-fs')).toBe(true)
    expect(stepUsesPlugin(s1, 'include:tool-search')).toBe(false)
  })
})
