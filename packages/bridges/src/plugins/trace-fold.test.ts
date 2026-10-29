import { describe, expect, it } from 'vitest'
import type { SessionEventLike } from '../dsh/session'
import {
  applySessionEvent,
  createInitialProjectionState,
  type TraceProjectionState,
  traceProjectionStateSchema,
} from './trace-fold'

const sessionId = 'sess-1'

function event(type: string, data: unknown, seq: number, time = 1000 + seq): SessionEventLike {
  return { type, seq, time, data }
}

function fold(events: SessionEventLike[]): TraceProjectionState {
  let state = createInitialProjectionState(sessionId)
  for (const item of events) state = applySessionEvent(state, item)
  return state
}

describe('applySessionEvent（trace 投影 fold）', () => {
  it('turn/step/tool 全链路折叠，id 与 PROTOCOL §4 派生规则一致', () => {
    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event(
        'user/message',
        { content: [{ type: 'text', text: '看看项目' }], source: { kind: 'user' } },
        1,
      ),
      event('step/start', { turn: 1, step: 1 }, 2),
      event(
        'assistant/message',
        { turn: 1, step: 1, message: { content: [{ text: '先读 README' }] } },
        3,
      ),
      event(
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{"path":"README.md"}' },
        4,
      ),
      event(
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [
              {
                toolCallId: 'c1',
                content: [
                  { type: 'text', text: 'README 内容' },
                  { type: 'image', data: 'ignored' },
                ],
              },
            ],
          },
        },
        5,
      ),
      event('step/end', { turn: 1, step: 1 }, 6),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
    ])

    const turn = state.turns[0]
    if (turn === undefined) throw new Error('expected turn')
    expect(turn.id).toBe('sess-1:t1')
    expect(turn.userMessage).toBe('看看项目')
    expect(turn.status).toBe('completed')
    expect(state.activeStepId).toBeNull()

    const step = turn.steps[0]
    if (step === undefined) throw new Error('expected step')
    expect(step.id).toBe('sess-1:t1:s1')
    expect(step.index).toBe(0)
    expect(step.llmReasoning).toBe('先读 README')
    expect(step.status).toBe('success')

    const call = step.toolCalls[0]
    if (call === undefined) throw new Error('expected tool call')
    expect(call.id).toBe('sess-1:c1')
    expect(call.toolName).toBe('read_file')
    expect(call.input).toEqual({ path: 'README.md' })
    expect(call.status).toBe('success')
    expect(call.endedAt).toBeGreaterThan(call.startedAt)
    expect(call.output).toBe('README 内容')
    expect(call.durationMs).toBe((call.endedAt ?? 0) - call.startedAt)

    expect(traceProjectionStateSchema.safeParse(state).success).toBe(true)
  })

  it('无关事件返回同一引用；重复事件幂等', () => {
    const start = createInitialProjectionState(sessionId)
    const same = applySessionEvent(start, event('system/message', {}, 0))
    expect(same).toBe(start)

    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
    ])
    const again = applySessionEvent(state, event('step/start', { turn: 1, step: 1 }, 1))
    expect(again).toBe(state)
  })

  it('只把 kind=user 的首条消息当作 prompt（忽略 plugin 注入的系统提醒）', () => {
    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event(
        'user/message',
        { content: [{ text: '系统提醒：文件有变化' }], source: { kind: 'plugin' } },
        1,
      ),
      event('user/message', { content: [{ text: '真正的提问' }], source: { kind: 'user' } }, 2),
      event('user/message', { content: [{ text: '后续系统注入' }], source: { kind: 'plugin' } }, 3),
    ])
    expect(state.turns[0]?.userMessage).toBe('真正的提问')
  })

  it('assistant/message 同时保留 Step 推理和 Turn 最终回复', () => {
    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event(
        'assistant/message',
        { turn: 1, step: 1, message: { content: [{ text: '已读取 README' }] } },
        2,
      ),
      event('step/end', { turn: 1, step: 1 }, 3),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
    ])
    expect(state.turns[0]?.assistantMessage).toBe('已读取 README')
    expect(state.turns[0]?.steps[0]?.llmReasoning).toBe('已读取 README')
  })

  it('思考与可见输出分开落库（reasoning 块 ≠ text 块）', () => {
    // 真机形态：`assistant/message.content` = [reasoning, text, tool-call…]。
    // 旧实现把两块拼成一坨塞进 llmReasoning，时间线上那行「推理摘要」因此变成碎片。
    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: 'reasoning', text: '用户在问项目结构，先看 README' },
              { type: 'text', text: '我先读一下 README。' },
              { type: 'tool-call', id: 'c1', name: 'read' },
            ],
          },
        },
        2,
      ),
    ])
    const step = state.turns[0]?.steps[0]
    expect(step?.reasoning).toBe('用户在问项目结构，先看 README')
    expect(step?.llmReasoning).toBe('我先读一下 README。')
    expect(step?.llmReasoning).not.toContain('reasoning')
    expect(state.turns[0]?.assistantMessage).toBe('我先读一下 README。')
  })

  it('只有思考、还没有可见输出时不写入 llmReasoning（保持同引用语义）', () => {
    const reasoningOnly = { content: [{ type: 'reasoning', text: '还在想' }] }
    const base = fold([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
    ])
    const after = applySessionEvent(
      base,
      event('assistant/message', { turn: 1, step: 1, message: reasoningOnly }, 2),
    )
    expect(after.turns[0]?.steps[0]?.reasoning).toBe('还在想')
    expect(after.turns[0]?.steps[0]?.llmReasoning).toBe('')
    expect(after.turns[0]?.assistantMessage).toBeUndefined()
    // 同一份思考重复到达 → 引用不变（投影契约：无关事件保持同引用）
    const again = applySessionEvent(
      after,
      event('assistant/message', { turn: 1, step: 1, message: reasoningOnly }, 3),
    )
    expect(again).toBe(after)
  })

  it('失败语义：tool/result 带 error 或 isError → failed；turn/end 非 completed → failed', () => {
    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event(
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'edit_file', arguments: 'not-json' },
        2,
      ),
      event(
        'tool/result',
        { turn: 1, step: 1, message: { content: [{ toolCallId: 'c1', isError: true }] } },
        3,
      ),
      event('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 4),
    ])

    const turn = state.turns[0]
    if (turn === undefined) throw new Error('expected turn')
    expect(turn.status).toBe('failed')
    expect(turn.steps[0]?.toolCalls[0]?.status).toBe('failed')
    expect(turn.steps[0]?.toolCalls[0]?.input).toEqual({ raw: 'not-json' })
  })

  it('turn/end 的任何 kind 都会收尾（含 forked 与未知取值），不把 turn 留在 running', () => {
    // `TurnEndReasonMap` 是 merge-extensible 的，漏列任何一种 kind 都会让 turn 永久
    // 停在 running ——界面卡在「正在执行任务」。这里把已知的 forked 与一个未来才可能
    // 出现的未知取值都覆盖上。
    for (const kind of ['forked', 'interrupted', 'brand-new-reason']) {
      const state = fold([
        event('turn/start', { turn: 1 }, 0),
        event('turn/end', { turn: 1, reason: { kind } }, 1),
      ])
      const turn = state.turns[0]
      if (turn === undefined) throw new Error('expected turn')
      expect(turn.status, `kind=${kind}`).toBe('failed')
      expect(turn.endedAt, `kind=${kind}`).toBe(1001)
    }
  })

  it('turn/end 的 reason.error 原样带出（D03 回归：失败必须可见）', () => {
    const state = fold([
      event('turn/start', { turn: 1 }, 0),
      event(
        'turn/end',
        {
          turn: 1,
          reason: {
            kind: 'error',
            error: {
              code: 'UNSUPPORTED_REASONING_EFFORT',
              message:
                'provider "deepseek-official" model "deepseek-flash" does not support reasoning effort "medium"',
            },
          },
        },
        4,
      ),
    ])
    const turn = state.turns[0]
    if (turn === undefined) throw new Error('expected turn')
    expect(turn.status).toBe('failed')
    expect(turn.failureCode).toBe('UNSUPPORTED_REASONING_EFFORT')
    expect(turn.failureMessage).toContain('does not support reasoning effort')
  })

  it('正常收尾不带失败原因；用户主动停止也不带', () => {
    const completed = fold([
      event('turn/start', { turn: 1 }, 0),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
    ])
    expect(completed.turns[0]?.failureCode).toBeUndefined()
    expect(completed.turns[0]?.failureMessage).toBeUndefined()

    const aborted = fold([
      event('turn/start', { turn: 1 }, 0),
      event('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 2),
    ])
    expect(aborted.turns[0]?.status).toBe('failed')
    expect(aborted.turns[0]?.failureCode).toBeUndefined()
  })

  it('重放同一事件流结果一致（可复现）', () => {
    const events = [
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{}' }, 2),
      event(
        'tool/result',
        { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [] } },
        3,
      ),
      event('step/end', { turn: 1, step: 1 }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]
    expect(fold(events)).toEqual(fold(events))
  })

  it('折叠真实 permission/sandbox/approval 事件并保留审批关联', () => {
    const state = fold([
      event('permission/preset', { preset: 'workspace-write' }, 0),
      event('sandbox/mode', { mode: 'workspace-write' }, 1),
      event('approval/policy', { policy: 'ask' }, 2),
      event(
        'approval/asked',
        { id: 'req-1', toolName: 'edit_file', callId: 'c1', reason: '写入文件' },
        3,
      ),
      event('approval/decided', { id: 'req-1', outcome: 'rejected' }, 4),
    ])

    expect(state.policyChanges.map((item) => [item.kind, item.value])).toEqual([
      ['preset', 'workspace-write'],
      ['sandbox', 'workspace-write'],
      ['approval', 'ask'],
    ])
    expect(state.approvals).toEqual([
      {
        sessionId,
        requestId: 'req-1',
        phase: 'asked',
        toolName: 'edit_file',
        callId: 'c1',
        reason: '写入文件',
        at: 1003,
      },
      {
        sessionId,
        requestId: 'req-1',
        phase: 'decided',
        toolName: 'edit_file',
        callId: 'c1',
        reason: '写入文件',
        outcome: 'rejected',
        at: 1004,
      },
    ])
  })
})
