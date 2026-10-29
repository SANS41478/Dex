import { describe, expect, it } from 'vitest'
import { makeMessage, type TraceMessage } from './protocol'
import { initialTraceState, type TraceState } from './trace'
import { applyTraceMessage, traceStateToMessages, truncateTraceStateAtStep } from './trace-replay'

const messages: TraceMessage[] = [
  makeMessage('trace.turn.start', { turnId: 't1', userMessage: '', at: 1 }),
  makeMessage('trace.step.start', { turnId: 't1', stepId: 's1', index: 0, at: 2 }),
  makeMessage('trace.turn.update', { turnId: 't1', userMessage: 'hello', at: 3 }),
  makeMessage('trace.tool.start', {
    toolCallId: 'c1',
    stepId: 's1',
    toolName: 'read',
    pluginId: 'plugin-fs',
    input: { path: 'README.md' },
    at: 4,
  }),
  makeMessage('trace.tool.end', {
    toolCallId: 'c1',
    stepId: 's1',
    status: 'failed',
    output: 'nope',
    durationMs: 5,
    at: 9,
  }),
]

function fold(items: readonly TraceMessage[]): TraceState {
  return items.reduce((state, message) => applyTraceMessage(state, message), initialTraceState)
}

describe('shared trace replay', () => {
  it('folds complete and in-flight trace states without duplicating repeated messages', () => {
    const state = fold(messages)
    const repeated = fold([...messages, ...messages])
    expect(repeated).toEqual(state)
    expect(state.turns[0]).toMatchObject({ userMessage: 'hello', status: 'running' })
    expect(state.turns[0]?.steps[0]?.toolCalls[0]).toMatchObject({
      status: 'failed',
      durationMs: 5,
    })
  })

  it('保留 turn 的最终 assistantMessage，供聊天窗口回显', () => {
    const state = fold([
      ...messages,
      makeMessage('trace.step.end', { stepId: 's1', status: 'success', at: 10 }),
      makeMessage('trace.turn.end', {
        turnId: 't1',
        status: 'completed',
        assistantMessage: 'README.md 内容已读取。',
        at: 11,
      }),
    ])
    expect(state.turns[0]?.assistantMessage).toBe('README.md 内容已读取。')
    expect(fold(traceStateToMessages(state))).toEqual(state)
  })

  it('serializes a canonical replay that folds back to the same state', () => {
    const state = fold(messages)
    const replay = traceStateToMessages(state)
    expect(replay.map((message) => message.type)).toEqual([
      'trace.turn.start',
      'trace.step.start',
      'trace.tool.start',
      'trace.tool.end',
    ])
    expect(fold(replay)).toEqual(state)
  })

  it('思考与可见文本互不污染，且能随回放原样往返', () => {
    const state = fold([
      ...messages,
      makeMessage('trace.step.reasoning', { stepId: 's1', reasoning: '先看 README', at: 6 }),
      makeMessage('trace.step.end', {
        stepId: 's1',
        status: 'success',
        llmReasoning: '我读一下 README。',
        reasoning: '先看 README',
        at: 10,
      }),
    ])
    const step = state.turns[0]?.steps[0]
    expect(step?.reasoning).toBe('先看 README')
    expect(step?.llmReasoning).toBe('我读一下 README。')

    const replay = traceStateToMessages(state)
    expect(replay.map((message) => message.type)).toEqual([
      'trace.turn.start',
      'trace.step.start',
      'trace.step.reasoning',
      'trace.tool.start',
      'trace.tool.end',
      'trace.step.end',
    ])
    expect(fold(replay)).toEqual(state)
  })

  it('keeps a completed turn and a later running turn in stable order', () => {
    const completed = makeMessage('trace.turn.end', { turnId: 't1', status: 'completed', at: 10 })
    const later = makeMessage('trace.turn.start', { turnId: 't2', userMessage: 'next', at: 11 })
    const state = fold([...messages, completed, later])
    const replay = traceStateToMessages(state)
    expect(replay).toHaveLength(6)
    expect(replay[0]?.type).toBe('trace.turn.start')
    expect(replay.at(-1)?.type).toBe('trace.turn.start')
    expect(fold(replay)).toEqual(state)
  })

  it('replays policy changes and approval audit without duplication', () => {
    const policy = makeMessage('trace.policy', {
      sessionId: 'sess-1',
      changeId: 'sess-1:policy:1',
      kind: 'sandbox',
      value: 'workspace-write',
      at: 12,
    })
    const asked = makeMessage('trace.approval', {
      sessionId: 'sess-1',
      requestId: 'req-1',
      phase: 'asked',
      toolName: 'edit_file',
      callId: 'sess-1:c1',
      reason: '需要写入文件',
      at: 13,
    })
    const decided = makeMessage('trace.approval', {
      sessionId: 'sess-1',
      requestId: 'req-1',
      phase: 'decided',
      toolName: 'edit_file',
      callId: 'sess-1:c1',
      reason: '需要写入文件',
      outcome: 'rejected',
      at: 14,
    })
    const state = fold([policy, asked, decided, policy, asked, decided])
    expect(state.policyChanges).toHaveLength(1)
    expect(state.approvals).toHaveLength(2)
    expect(fold(traceStateToMessages(state))).toEqual(state)
  })

  it('截断到目标 step，保留目标内容并丢弃后续 step 与审计记录', () => {
    const secondStep = makeMessage('trace.step.start', {
      turnId: 't1',
      stepId: 's2',
      index: 1,
      at: 15,
    })
    const secondTool = makeMessage('trace.tool.start', {
      toolCallId: 'c2',
      stepId: 's2',
      toolName: 'write',
      pluginId: 'plugin-fs',
      input: { path: 'out.txt' },
      at: 16,
    })
    const laterPolicy = makeMessage('trace.policy', {
      sessionId: 'sess-1',
      changeId: 'sess-1:policy:20',
      kind: 'approval',
      value: 'ask',
      at: 20,
    })
    const state = fold([
      ...messages,
      makeMessage('trace.step.end', { stepId: 's1', status: 'success', at: 10 }),
      secondStep,
      secondTool,
      laterPolicy,
    ])

    const result = truncateTraceStateAtStep(state, 's1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stepIndex).toBe(0)
    expect(result.stepCount).toBe(2)
    expect(result.state.turns[0]?.steps.map((step) => step.id)).toEqual(['s1'])
    expect(result.state.turns[0]?.steps[0]?.toolCalls[0]?.output).toBe('nope')
    expect(result.state.policyChanges.map((change) => change.changeId)).toEqual([])
    expect(result.state.approvals).toHaveLength(0)
  })

  it('目标 step 不是 turn 最后一步时，历史 turn 保持 running', () => {
    const state = fold([
      ...messages,
      makeMessage('trace.step.end', { stepId: 's1', status: 'success', at: 10 }),
      makeMessage('trace.step.start', { turnId: 't1', stepId: 's2', index: 1, at: 11 }),
      makeMessage('trace.turn.end', { turnId: 't1', status: 'completed', at: 12 }),
    ])
    const result = truncateTraceStateAtStep(state, 's1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.turns[0]).toMatchObject({ status: 'running' })
    expect(result.state.turns[0]?.endedAt).toBeUndefined()
  })

  it('找不到 step 时返回明确错误且不构造新状态', () => {
    const state = fold(messages)
    expect(truncateTraceStateAtStep(state, 'missing')).toEqual({
      ok: false,
      error: '找不到 Step：missing',
    })
  })
})
