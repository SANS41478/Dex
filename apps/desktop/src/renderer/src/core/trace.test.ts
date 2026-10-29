import { isTraceMessage, type Message, makeMessage } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { applyTraceMessage, initialTraceState, type TraceState } from './trace'

const turnStart = makeMessage('trace.turn.start', { turnId: 't1', userMessage: '你好', at: 1 })
const stepStart = makeMessage('trace.step.start', { turnId: 't1', stepId: 's1', index: 0, at: 2 })
const toolStart = makeMessage('trace.tool.start', {
  toolCallId: 'c1',
  stepId: 's1',
  toolName: 'read_file',
  pluginId: 'plugin-tool-fs',
  input: { path: 'a.ts' },
  at: 3,
})
const toolEnd = makeMessage('trace.tool.end', {
  toolCallId: 'c1',
  stepId: 's1',
  status: 'success',
  output: 'ok',
  durationMs: 10,
  at: 4,
})
const stepEnd = makeMessage('trace.step.end', {
  stepId: 's1',
  status: 'success',
  llmReasoning: '读完了',
  at: 5,
})
const turnEnd = makeMessage('trace.turn.end', { turnId: 't1', status: 'completed', at: 6 })

function fold(messages: Message[]): TraceState {
  return messages.reduce<TraceState>((state, message) => {
    if (!isTraceMessage(message)) return state
    return applyTraceMessage(state, message)
  }, initialTraceState)
}

describe('applyTraceMessage', () => {
  it('按顺序折叠出完整结构', () => {
    const state = fold([turnStart, stepStart, toolStart, toolEnd, stepEnd, turnEnd])
    expect(state.turns).toHaveLength(1)
    const turn = state.turns[0]
    expect(turn?.status).toBe('completed')
    expect(turn?.steps).toHaveLength(1)
    const step = turn?.steps[0]
    expect(step?.status).toBe('success')
    expect(step?.llmReasoning).toBe('读完了')
    expect(step?.toolCalls[0]?.status).toBe('success')
    expect(step?.toolCalls[0]?.durationMs).toBe(10)
    expect(state.activeStepId).toBeNull()
  })

  it('运行中的 step 会成为 activeStepId', () => {
    const state = fold([turnStart, stepStart])
    expect(state.activeStepId).toBe('s1')
  })

  it('失败状态被正确记录', () => {
    const failing = makeMessage('trace.step.end', { stepId: 's1', status: 'failed', at: 7 })
    const state = fold([turnStart, stepStart, failing])
    expect(state.turns[0]?.steps[0]?.status).toBe('failed')
  })

  it('turn.update 补全晚到的 userMessage；重复/未知目标保持同引用', () => {
    const empty = makeMessage('trace.turn.start', { turnId: 't1', userMessage: '', at: 1 })
    const update = makeMessage('trace.turn.update', {
      turnId: 't1',
      userMessage: '真实提问',
      at: 2,
    })
    const state = fold([empty, update])
    expect(state.turns[0]?.userMessage).toBe('真实提问')

    const again = applyTraceMessage(state, update)
    expect(again).toBe(state)
    const unknown = makeMessage('trace.turn.update', {
      turnId: 'missing',
      userMessage: 'x',
      at: 3,
    })
    expect(applyTraceMessage(state, unknown)).toBe(state)
  })

  it('重复消息与未知目标不会破坏状态', () => {
    const first = fold([turnStart, stepStart])
    const second = applyTraceMessage(first, turnStart)
    expect(second).toBe(first)
    const unknownStep = makeMessage('trace.step.end', {
      stepId: 'missing',
      status: 'failed',
      at: 9,
    })
    expect(applyTraceMessage(first, unknownStep)).toBe(first)
  })
})
