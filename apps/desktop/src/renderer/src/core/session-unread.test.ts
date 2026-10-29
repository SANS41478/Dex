import { describe, expect, it } from 'vitest'
import { collectUnread, markSessionRead } from './session-unread'

const base = {
  unread: [] as readonly string[],
  sessionId: 's-1',
  activeSessionId: null,
}

describe('collectUnread', () => {
  it('running→idle 且非当前会话 → 计入未读', () => {
    expect(collectUnread({ ...base, previous: 'running', next: 'idle' })).toEqual(['s-1'])
  })

  it('当前会话自己的完成不计未读', () => {
    expect(
      collectUnread({ ...base, previous: 'running', next: 'idle', activeSessionId: 's-1' }),
    ).toEqual([])
  })

  it('previous 未知（缺键）不得当作 running → 不计', () => {
    expect(collectUnread({ ...base, previous: undefined, next: 'idle' })).toEqual([])
  })

  it('非 running→idle 跃迁不计（启动、持续 running、持续 idle）', () => {
    expect(collectUnread({ ...base, previous: 'idle', next: 'running' })).toEqual([])
    expect(collectUnread({ ...base, previous: 'running', next: 'running' })).toEqual([])
    expect(collectUnread({ ...base, previous: 'idle', next: 'idle' })).toEqual([])
  })

  it('已在未读集内不重复计', () => {
    expect(collectUnread({ ...base, unread: ['s-1'], previous: 'running', next: 'idle' })).toEqual([
      's-1',
    ])
  })
})

describe('markSessionRead', () => {
  it('清除指定会话，其余保留；未在集内时原样返回', () => {
    expect(markSessionRead(['s-1', 's-2'], 's-1')).toEqual(['s-2'])
    expect(markSessionRead(['s-2'], 's-1')).toEqual(['s-2'])
  })
})
