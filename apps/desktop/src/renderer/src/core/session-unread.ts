/**
 * completionUnread（照搬 dsh Web 层契约的最小实现）：
 * 会话在**非当前视图**下从 running 跃迁到 idle（= 后台完成），计入未读；
 * 用户进入该会话（markRead）即清除。纯函数，单测覆盖全分支。
 */

export type SessionRunStatus = 'idle' | 'running'

export function collectUnread(input: {
  readonly unread: readonly string[]
  readonly sessionId: string
  /** 跃迁前的状态；`undefined` = 未知（缺键不得当作 running，见 sessionStatusStore）。 */
  readonly previous: SessionRunStatus | undefined
  readonly next: SessionRunStatus
  readonly activeSessionId: string | null
}): readonly string[] {
  if (input.previous !== 'running' || input.next !== 'idle') return input.unread
  if (input.sessionId === input.activeSessionId) return input.unread
  if (input.unread.includes(input.sessionId)) return input.unread
  return [...input.unread, input.sessionId]
}

export function markSessionRead(unread: readonly string[], sessionId: string): readonly string[] {
  return unread.includes(sessionId) ? unread.filter((id) => id !== sessionId) : unread
}
