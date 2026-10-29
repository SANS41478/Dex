import { useEffect, useRef } from 'react'
import { readRestorableSession, rememberActiveSession } from '../core/session-restore'
import { useChatStore } from '../stores/chatStore'
import { useHostStore } from '../stores/hostStore'
import { useSessionStore } from '../stores/sessionStore'

/**
 * 冷启动时恢复「上次打开的会话」（D08）。
 *
 * 时机选在宿主 ready 之后：历史会话要走宿主侧 resume（D33），宿主没起来时 activate 必然失败，
 * 早试一次只会白留一条错误。
 *
 * 失败就把书签清掉——会话可能已经被删掉，或者换了机器，留着它会让每次启动都重试一遍。
 * 用户在这之前已经手动开了会话时也不抢（`activeSessionId !== null` 就放弃恢复）。
 */
export function useRestoreActiveSession(): void {
  const hostReady = useHostStore((state) => state.phase === 'ready')
  const attempted = useRef(false)

  useEffect(() => {
    if (!hostReady || attempted.current) return
    if (useChatStore.getState().activeSessionId !== null) return
    const pending = readRestorableSession()
    if (pending === null) return
    attempted.current = true
    void useChatStore
      .getState()
      .activate(pending.sessionId, pending.workspacePath)
      .then(() => useSessionStore.getState().replay(pending.sessionId, true))
      .catch(() => {
        rememberActiveSession(null)
      })
  }, [hostReady])
}
