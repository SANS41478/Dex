import { create } from 'zustand'
import { collectUnread, markSessionRead, type SessionRunStatus } from '../core/session-unread'

/**
 * 后台完成的未读集合（C-5 · completionUnread）。
 * 数据流：useEventStream 的 session.status 分支在 sessionStatusStore.apply 同点喂
 * observe（带上跃迁前状态）；会话激活（chatStore.activate）时 markRead。
 */
export interface SessionUnreadStore {
  readonly unread: readonly string[]
  observe: (
    sessionId: string,
    previous: SessionRunStatus | undefined,
    next: SessionRunStatus,
    activeSessionId: string | null,
  ) => void
  markRead: (sessionId: string) => void
}

export const useSessionUnreadStore = create<SessionUnreadStore>((set, get) => ({
  unread: [],
  observe: (sessionId, previous, next, activeSessionId) => {
    const result = collectUnread({
      unread: get().unread,
      sessionId,
      previous,
      next,
      activeSessionId,
    })
    if (result !== get().unread) set({ unread: result })
  },
  markRead: (sessionId) => {
    const result = markSessionRead(get().unread, sessionId)
    if (result !== get().unread) set({ unread: result })
  },
}))
