import { describe, expect, it } from 'vitest'
import { makeMessage, parseEnvelope } from './protocol'

const validTurnStart = makeMessage('trace.turn.start', {
  turnId: 'turn-1',
  userMessage: '你好',
  at: 1,
})

describe('parseEnvelope', () => {
  it('接受合法消息', () => {
    const result = parseEnvelope(validTurnStart)
    expect(result.ok).toBe(true)
  })

  it('拒绝未知消息类型', () => {
    const result = parseEnvelope({ ...validTurnStart, type: 'unknown.event' })
    expect(result.ok).toBe(false)
  })

  it('拒绝缺少必填字段的消息', () => {
    const result = parseEnvelope({
      v: 1,
      type: 'trace.step.start',
      ts: 1,
      payload: { stepId: 'step-1' },
    })
    expect(result.ok).toBe(false)
  })

  it('拒绝错误的协议版本', () => {
    const result = parseEnvelope({ ...validTurnStart, v: 2 })
    expect(result.ok).toBe(false)
  })

  it('拒绝非对象输入且不抛异常', () => {
    expect(parseEnvelope(null).ok).toBe(false)
    expect(parseEnvelope('not-a-message').ok).toBe(false)
    expect(parseEnvelope(42).ok).toBe(false)
  })

  it("接受兜底插件类型 'other' 的图谱消息", () => {
    const result = parseEnvelope(
      makeMessage('graph.upsert', {
        nodes: [{ id: 'entry-a', label: 'plugin-a', type: 'other', status: 'inactive' }],
        links: [],
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('校验宿主状态消息（含可选 detail）', () => {
    expect(parseEnvelope(makeMessage('host.status', { phase: 'ready' })).ok).toBe(true)
    expect(
      parseEnvelope(makeMessage('host.status', { phase: 'error', detail: 'dsh 退出' })).ok,
    ).toBe(true)
    expect(
      parseEnvelope({
        v: 1,
        type: 'host.status',
        ts: 1,
        payload: { phase: 'unknown' },
      }).ok,
    ).toBe(false)
  })

  it('校验 turn 元信息补全消息（userMessage 晚于 turn/start 到达）', () => {
    const update = makeMessage('trace.turn.update', {
      turnId: 'turn-1',
      userMessage: '看看项目结构',
      at: 2,
    })
    const parsed = parseEnvelope(update)
    expect(parsed.ok).toBe(true)
    expect(
      parseEnvelope({ v: 1, type: 'trace.turn.update', ts: 1, payload: { turnId: 't' } }).ok,
    ).toBe(false)
  })

  it('校验会话级运行状态消息', () => {
    expect(
      parseEnvelope(makeMessage('session.status', { sessionId: 'sess-1', status: 'running' })).ok,
    ).toBe(true)
    expect(
      parseEnvelope(makeMessage('session.status', { sessionId: 'sess-1', status: 'idle' })).ok,
    ).toBe(true)
    // 状态取值域是闭合的：dsh 的 AgentStatus 只有 idle / running，别的一律拒收。
    expect(
      parseEnvelope({
        v: 1,
        type: 'session.status',
        ts: 1,
        payload: { sessionId: 's', status: 'busy' },
      }).ok,
    ).toBe(false)
    expect(
      parseEnvelope({ v: 1, type: 'session.status', ts: 1, payload: { status: 'idle' } }).ok,
    ).toBe(false)
  })

  it('JSON 往返后结构不变', () => {
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(validTurnStart)))
    if (!parsed.ok) throw new Error('expected valid message')
    expect(parsed.message).toEqual(validTurnStart)
  })

  it('校验权限策略与审批审计消息', () => {
    expect(
      parseEnvelope(
        makeMessage('trace.policy', {
          sessionId: 'sess-1',
          changeId: 'sess-1:policy:1',
          kind: 'sandbox',
          value: 'workspace-write',
          at: 2,
        }),
      ).ok,
    ).toBe(true)
    expect(
      parseEnvelope(
        makeMessage('trace.approval', {
          sessionId: 'sess-1',
          requestId: 'req-1',
          phase: 'decided',
          toolName: 'edit_file',
          outcome: 'rejected',
          at: 3,
        }),
      ).ok,
    ).toBe(true)
    expect(
      parseEnvelope({
        v: 1,
        type: 'trace.approval',
        ts: 3,
        payload: {
          sessionId: 'sess-1',
          requestId: 'req-1',
          phase: 'decided',
          toolName: 'edit_file',
          at: 3,
        },
      }).ok,
    ).toBe(true)
  })
})
