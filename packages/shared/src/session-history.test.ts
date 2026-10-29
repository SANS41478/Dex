import { describe, expect, it } from 'vitest'
import { sortSessionSummaries, summarizeSessionEvents } from './session-history'

const event = (type: string, seq: number, data: unknown, time = 1000 + seq) => ({
  type,
  seq,
  time,
  data,
})

describe('session history helpers', () => {
  it('优先使用 session/title，统计任务和完成状态', () => {
    const summary = summarizeSessionEvents('s1', [
      event('session/title', 0, { title: '修复登录' }),
      event('turn/start', 1, { turn: 1 }),
      event('user/message', 2, {
        content: [{ text: '无关的系统首屏' }],
        source: { kind: 'user' },
      }),
      event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(summary).toMatchObject({
      sessionId: 's1',
      title: '修复登录',
      status: 'completed',
      taskCount: 1,
      lastEventAt: 1003,
      updatedAt: 1003,
    })
  })

  it('session/title 是 last-wins：用户重命名覆盖更早的自动标题', () => {
    const summary = summarizeSessionEvents('s3', [
      event('session/title', 0, { title: '自动标题' }),
      event('turn/start', 1, { turn: 1 }),
      event('session/title', 2, { title: '用户改名' }),
    ])
    expect(summary.title).toBe('用户改名')
  })

  it('缺标题时回退真实 user message，未结束 turn 为 running', () => {
    const summary = summarizeSessionEvents('s2', [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, {
        content: [{ type: 'text', text: '检查部署配置' }],
        source: { kind: 'user' },
      }),
    ])
    expect(summary.title).toBe('检查部署配置')
    expect(summary.status).toBe('running')
    expect(summary.taskCount).toBe(1)
    expect(summary.blank).toBe(false)
  })

  it('只有尚未开始过 turn 的会话才是 blank，独立事件不改变该状态', () => {
    expect(
      summarizeSessionEvents('blank', [event('session/title', 0, { title: 'New Session' })]).blank,
    ).toBe(true)
    expect(summarizeSessionEvents('used', [event('turn/start', 0, { turn: 1 })]).blank).toBe(false)
  })

  it('按更新时间倒序，时间相同按 sessionId 稳定排序', () => {
    const sorted = sortSessionSummaries([
      { sessionId: 'b', title: 'b', status: 'completed', taskCount: 1, updatedAt: 10 },
      { sessionId: 'a', title: 'a', status: 'completed', taskCount: 1, updatedAt: 10 },
      { sessionId: 'c', title: 'c', status: 'unknown', taskCount: 0, updatedAt: 20 },
    ])
    expect(sorted.map((item) => item.sessionId)).toEqual(['c', 'a', 'b'])
  })
})
