import { describe, expect, it } from 'vitest'
import type { SessionEventLike } from '../dsh/session'
import {
  createTraceBridge,
  diffTraceMessages,
  type TraceMappingOptions,
  traceStateToMessages,
} from './trace-bridge'
import {
  applySessionEvent,
  createInitialProjectionState,
  type TraceProjectionState,
} from './trace-fold'

const sessionId = 'sess-1'
const options: TraceMappingOptions = {
  resolvePluginId: (toolName) => (toolName === 'read' ? 'entry-fs' : 'unknown'),
  now: () => 999,
}

function event(type: string, data: unknown, seq: number, time = 1000 + seq): SessionEventLike {
  return { type, seq, time, data }
}

/** 逐步 fold 事件流，返回每一步之后的状态快照（含初始状态）。 */
function statesOf(events: SessionEventLike[]): TraceProjectionState[] {
  let state = createInitialProjectionState(sessionId)
  const states = [state]
  for (const item of events) {
    state = applySessionEvent(state, item)
    states.push(state)
  }
  return states
}

const fullEvents: SessionEventLike[] = [
  event('permission/preset', { preset: 'workspace-write' }, 0),
  event('sandbox/mode', { mode: 'workspace-write' }, 1),
  event('approval/policy', { policy: 'ask' }, 2),
  event('turn/start', { turn: 1 }, 3),
  event('step/start', { turn: 1, step: 1 }, 4),
  event(
    'user/message',
    { content: [{ type: 'text', text: '看看项目结构' }], source: { kind: 'user' } },
    5,
  ),
  event(
    'assistant/message',
    { turn: 1, step: 1, message: { content: [{ text: '先读 README' }] } },
    6,
  ),
  event(
    'tool/call',
    { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README.md"}' },
    7,
  ),
  event(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'README 内容' }] }],
      },
    },
    8,
  ),
  event('step/end', { turn: 1, step: 1 }, 9),
  event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10),
]

describe('traceStateToMessages（全量回放）', () => {
  it('按序输出六类消息，pluginId / output / durationMs 齐全', () => {
    const state = statesOf(fullEvents).at(-1)
    if (state === undefined) throw new Error('expected state')
    const messages = traceStateToMessages(state, options)

    expect(messages.map((message) => message.type)).toEqual([
      'trace.turn.start',
      'trace.step.start',
      'trace.tool.start',
      'trace.tool.end',
      'trace.step.end',
      'trace.turn.end',
      'trace.policy',
      'trace.policy',
      'trace.policy',
    ])

    const toolStart = messages.find((message) => message.type === 'trace.tool.start')
    if (toolStart?.type !== 'trace.tool.start') throw new Error('expected tool start')
    expect(toolStart.payload).toMatchObject({
      toolCallId: 'sess-1:c1',
      stepId: 'sess-1:t1:s1',
      toolName: 'read',
      pluginId: 'entry-fs',
      input: { path: 'README.md' },
    })

    const toolEnd = messages.find((message) => message.type === 'trace.tool.end')
    if (toolEnd?.type !== 'trace.tool.end') throw new Error('expected tool end')
    expect(toolEnd.payload.status).toBe('success')
    expect(toolEnd.payload.output).toBe('README 内容')
    expect(toolEnd.payload.durationMs).toBe(1005 - 1004)

    const stepEnd = messages.find((message) => message.type === 'trace.step.end')
    if (stepEnd?.type !== 'trace.step.end') throw new Error('expected step end')
    expect(stepEnd.payload.llmReasoning).toBe('先读 README')

    const turnStart = messages.find((message) => message.type === 'trace.turn.start')
    if (turnStart?.type !== 'trace.turn.start') throw new Error('expected turn start')
    expect(turnStart.payload.userMessage).toBe('看看项目结构')
  })
})

describe('diffTraceMessages（增量）', () => {
  it('逐事件增量恰好产生一条对应消息（含晚到 userMessage 的 turn.update）', () => {
    const states = statesOf(fullEvents)
    const emitted = states.map((state, index) =>
      diffTraceMessages(states[index - 1] ?? null, state, options).map((message) => message.type),
    )
    expect(emitted).toEqual([
      [],
      ['trace.policy'],
      ['trace.policy'],
      ['trace.policy'],
      ['trace.turn.start'],
      ['trace.step.start'],
      ['trace.turn.update'],
      [],
      ['trace.tool.start'],
      ['trace.tool.end'],
      ['trace.step.end'],
      ['trace.turn.end'],
    ])
  })

  it('同一引用返回空数组（fold 无关事件保持同引用）', () => {
    const state = statesOf(fullEvents).at(-1)
    if (state === undefined) throw new Error('expected state')
    expect(diffTraceMessages(state, state, options)).toEqual([])
  })

  it('晚到一个完整 turn（桥晚挂载）产生该 turn 的全量回放', () => {
    const states = statesOf(fullEvents)
    const fresh = states[0]
    const final = states.at(-1)
    if (fresh === undefined || final === undefined) throw new Error('expected states')
    const messages = diffTraceMessages(fresh, final, options)
    expect(messages.map((message) => message.type)).toEqual([
      'trace.turn.start',
      'trace.step.start',
      'trace.tool.start',
      'trace.tool.end',
      'trace.step.end',
      'trace.turn.end',
      'trace.policy',
      'trace.policy',
      'trace.policy',
    ])
  })

  it('思考在工具调用之前就下发（trace.step.reasoning），step.end 也带思考', () => {
    // `assistant/message` 在 `tool/call` 之前到达 → 思考可以边跑边看，不必等整步结束。
    const states = statesOf([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: 'reasoning', text: '先读 README，确认项目定位' },
              { type: 'text', text: '我先读一下 README。' },
            ],
          },
        },
        2,
      ),
      event(
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README.md"}' },
        3,
      ),
      event('step/end', { turn: 1, step: 1 }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ])
    const emitted = states.map((state, index) =>
      diffTraceMessages(states[index - 1] ?? null, state, options).map((message) => message.type),
    )
    expect(emitted).toEqual([
      [],
      ['trace.turn.start'],
      ['trace.step.start'],
      ['trace.step.reasoning'],
      ['trace.tool.start'],
      ['trace.step.end'],
      ['trace.turn.end'],
    ])

    const reasoningIndex = emitted.findIndex((types) => types.includes('trace.step.reasoning'))
    const toolIndex = emitted.findIndex((types) => types.includes('trace.tool.start'))
    expect(reasoningIndex).toBeGreaterThanOrEqual(0)
    expect(reasoningIndex).toBeLessThan(toolIndex)

    const beforeEnd = states[4]
    const afterEnd = states[5]
    if (beforeEnd === undefined || afterEnd === undefined) throw new Error('expected states')
    const stepEnd = diffTraceMessages(beforeEnd, afterEnd, options)[0]
    if (stepEnd?.type !== 'trace.step.end') throw new Error('expected step end')
    expect(stepEnd.payload.reasoning).toBe('先读 README，确认项目定位')
    expect(stepEnd.payload.llmReasoning).toBe('我先读一下 README。')
  })

  it('失败工具与失败 turn 映射为 failed（错误判定透传）', () => {
    const states = statesOf([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event(
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: 'not-json' },
        2,
      ),
      event(
        'tool/result',
        {
          turn: 1,
          step: 1,
          error: { name: 'ToolError' },
          message: { content: [{ toolCallId: 'c1', isError: true }] },
        },
        3,
      ),
      event('turn/end', { turn: 1, reason: { kind: 'error' } }, 4),
    ])
    const final = states.at(-1)
    if (final === undefined) throw new Error('expected state')
    const messages = diffTraceMessages(null, final, options)
    const toolEnd = messages.find((message) => message.type === 'trace.tool.end')
    if (toolEnd?.type !== 'trace.tool.end') throw new Error('expected tool end')
    expect(toolEnd.payload.status).toBe('failed')
    const turnEnd = messages.find((message) => message.type === 'trace.turn.end')
    if (turnEnd?.type !== 'trace.turn.end') throw new Error('expected turn end')
    expect(turnEnd.payload.status).toBe('failed')
  })
})

describe('createTraceBridge', () => {
  it('assistant 文本晚于 turn 结束到达时仍补发 turn.end，避免聊天区只显示用户消息', () => {
    const previous = statesOf([
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
    ]).at(-1)
    const next = {
      ...(previous ?? createInitialProjectionState(sessionId)),
      turns: (previous?.turns ?? []).map((turn) => ({
        ...turn,
        assistantMessage: '收到',
      })),
    }
    if (previous === undefined) throw new Error('expected previous state')
    const messages = diffTraceMessages(previous, next, options)
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'trace.turn.end',
        payload: expect.objectContaining({ assistantMessage: '收到' }),
      }),
    )
  })

  it('feed 增量入 sink，回放消息只按需产出且不改变基线', () => {
    const sent: string[] = []
    const bridge = createTraceBridge({
      ...options,
      sink: (message) => sent.push(message.type),
    })
    const states = statesOf(fullEvents)
    const first = states[1]
    const second = states[2]
    const final = states.at(-1)
    if (first === undefined || second === undefined || final === undefined) {
      throw new Error('expected states')
    }

    bridge.feed(first)
    bridge.feed(second)
    bridge.feed(final)
    expect(sent).toEqual([
      'trace.policy',
      'trace.policy',
      // final 相对 second 的增量：turn、tool、step、turn end、剩余策略
      'trace.turn.start',
      'trace.step.start',
      'trace.tool.start',
      'trace.tool.end',
      'trace.step.end',
      'trace.turn.end',
      'trace.policy',
    ])

    expect(bridge.sessions()).toEqual([sessionId])
    const replay = bridge.messagesFor(final)
    expect(replay).toHaveLength(9)
    // 回放不应把 last-sent 推回：再次 feed 同一状态仍为空
    sent.length = 0
    bridge.feed(final)
    expect(sent).toEqual([])
  })
})
