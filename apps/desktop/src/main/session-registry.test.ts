import { describe, expect, it } from 'vitest'
import {
  type ActiveSession,
  mapPromptFailure,
  mapResumeFailure,
  SESSION_NOT_RESUMABLE_CODE,
  SESSION_NOT_RESUMABLE_MESSAGE,
  SessionRegistry,
} from './session-registry'

function session(sessionId: string): ActiveSession {
  return {
    sessionId,
    workspacePath: 'D:\\工作区',
    provider: 'rings',
    model: 'gpt-6-luna',
    channel: 'stdio',
    busy: false,
  }
}

/** 补登记内容（`control` 通道的历史会话）。 */
function adopted(sessionId: string): Omit<ActiveSession, 'busy'> {
  return {
    sessionId,
    workspacePath: 'E:\\dexAgent',
    provider: 'rings',
    model: 'gpt-6-luna',
    channel: 'control',
  }
}

describe('SessionRegistry', () => {
  it('nextSessionId 生成可读且本次运行内唯一的 id', () => {
    const registry = new SessionRegistry()
    expect(registry.nextSessionId(1_700_000_000_000)).toBe('dex-1700000000000-1')
    expect(registry.nextSessionId(1_700_000_000_000)).toBe('dex-1700000000000-2')
  })

  it('register 后该会话成为活跃会话，且可从登记表取回', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))

    expect(registry.activeSessionId).toBe('dex-1-1')
    expect(registry.find('dex-1-1')?.workspacePath).toBe('D:\\工作区')
    expect(registry.resumable('dex-1-1')).toBe(true)
  })

  it('未登记的 id 不可继续：activate 返回 SESSION_NOT_RESUMABLE 且不改活跃会话', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))

    // 磁盘上存在、本进程没登记过的历史会话（用户点了侧边栏历史条目）。
    const failure = registry.activate('dex-1790134078153-1')

    expect(failure?.code).toBe(SESSION_NOT_RESUMABLE_CODE)
    expect(failure?.retryable).toBe(false)
    expect(failure?.message).toContain(SESSION_NOT_RESUMABLE_MESSAGE)
    expect(registry.resumable('dex-1790134078153-1')).toBe(false)
    // 关键：失败不得污染活跃会话，否则后续 prompt 会把历史 id 转给 dsh。
    expect(registry.activeSessionId).toBe('dex-1-1')
  })

  it('已登记的会话可以再次 activate（同一运行期内来回切换）', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))
    registry.register(session('dex-1-2'))

    expect(registry.activate('dex-1-1')).toBeNull()
    expect(registry.activeSessionId).toBe('dex-1-1')
  })

  it('当前会话忙碌时拒绝切换', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))
    registry.register(session('dex-1-2'))
    registry.activate('dex-1-1')
    const running = registry.find('dex-1-1')
    if (running === undefined) throw new Error('登记失败')
    running.busy = true

    expect(registry.activate('dex-1-2')?.code).toBe('SESSION_BUSY')
    // 忙碌会话不得被切走
    expect(registry.activeSessionId).toBe('dex-1-1')
  })

  it('activate 失败时不产出任何登记项（历史 id 不会被缓存成可继续）', () => {
    const registry = new SessionRegistry()
    registry.activate('dex-history-1')
    expect(registry.find('dex-history-1')).toBeUndefined()
  })

  it('带 adopt 时未登记的 id 会被补登记为 control 通道（宿主侧 resume 成功后）', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))

    expect(registry.activate('dex-history-1', adopted('dex-history-1'))).toBeNull()
    const context = registry.find('dex-history-1')
    expect(context?.channel).toBe('control')
    expect(context?.workspacePath).toBe('E:\\dexAgent')
    expect(context?.busy).toBe(false)
    expect(registry.activeSessionId).toBe('dex-history-1')
    expect(registry.resumable('dex-history-1')).toBe(true)
  })

  it('adopt 不会改写已登记会话的通道（同 id 不能中途换通道）', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))

    expect(registry.activate('dex-1-1', adopted('dex-1-1'))).toBeNull()
    expect(registry.find('dex-1-1')?.channel).toBe('stdio')
    expect(registry.find('dex-1-1')?.workspacePath).toBe('D:\\工作区')
  })

  it('adopt 也要过忙碌守卫：当前会话在跑时不切走，也不留下半开的登记', () => {
    const registry = new SessionRegistry()
    registry.register(session('dex-1-1'))
    const running = registry.find('dex-1-1')
    if (running === undefined) throw new Error('登记失败')
    running.busy = true

    expect(registry.activate('dex-history-1', adopted('dex-history-1'))?.code).toBe('SESSION_BUSY')
    expect(registry.find('dex-history-1')).toBeUndefined()
    expect(registry.activeSessionId).toBe('dex-1-1')
  })

  it('canActivate 只读地给出切换守卫，供「先做昂贵动作再切换」的调用方预检', () => {
    const registry = new SessionRegistry()
    expect(registry.canActivate()).toBeNull()
    registry.register(session('dex-1-1'))
    expect(registry.canActivate()).toBeNull()
    const running = registry.find('dex-1-1')
    if (running === undefined) throw new Error('登记失败')
    running.busy = true
    expect(registry.canActivate()?.code).toBe('SESSION_BUSY')
    // 只读：不改动活跃会话
    expect(registry.activeSessionId).toBe('dex-1-1')
  })
})

describe('mapPromptFailure', () => {
  it('把 dsh 的 already exists 收口成 SESSION_NOT_RESUMABLE', () => {
    const error = new Error('session "dex-1790134078153-1" already exists')
    const mapped = mapPromptFailure(error, 'dex-1790134078153-1')

    expect(mapped.code).toBe(SESSION_NOT_RESUMABLE_CODE)
    expect(mapped.retryable).toBe(false)
    expect(mapped.message).toContain('dex-1790134078153-1')
    // 不外泄 dsh 内部措辞
    expect(mapped.message).not.toContain('already exists')
  })

  it('其它失败保持 PROMPT_FAILED 且可重试', () => {
    const mapped = mapPromptFailure(new Error('ECONNRESET'), 'dex-1-1')

    expect(mapped.code).toBe('PROMPT_FAILED')
    expect(mapped.retryable).toBe(true)
    expect(mapped.message).toBe('ECONNRESET')
  })

  it('非 Error 值兜底为人话消息', () => {
    expect(mapPromptFailure(undefined, 'dex-1-1').message).toBe('发送任务失败')
  })
})

describe('mapResumeFailure', () => {
  it('宿主里已有同 id 活体 → 收口成 SESSION_NOT_RESUMABLE', () => {
    const mapped = mapResumeFailure(new Error('agent "dex-1" is already registered'), 'dex-1')

    expect(mapped.code).toBe(SESSION_NOT_RESUMABLE_CODE)
    expect(mapped.retryable).toBe(false)
    expect(mapped.message).not.toContain('already registered')
  })

  it('会话在磁盘上不存在 → 收口成 SESSION_NOT_RESUMABLE', () => {
    expect(mapResumeFailure(new Error('ENOENT: no such file'), 'dex-1').code).toBe(
      SESSION_NOT_RESUMABLE_CODE,
    )
  })

  it('环境类失败保留原始消息并标成可重试（说清楚比吞掉有用）', () => {
    const mapped = mapResumeFailure(
      new Error('cannot resume: session persistence is not configured'),
      'dex-1',
    )

    expect(mapped.code).toBe('SESSION_RESUME_FAILED')
    expect(mapped.retryable).toBe(true)
    expect(mapped.message).toContain('persistence')
  })

  it('非 Error 值兜底为人话消息', () => {
    expect(mapResumeFailure(undefined, 'dex-1').message).toBe('恢复历史会话失败')
  })
})
