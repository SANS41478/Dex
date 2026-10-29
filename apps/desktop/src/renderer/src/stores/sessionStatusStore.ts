import type { SessionStatus } from '@dexagent/shared'
import { create } from 'zustand'

/**
 * 会话级运行状态（宿主权威事实）。
 *
 * 为什么必须有这么一个 store：dsh 的「正在执行」是**会话级**事实，由宿主
 * `agent/status` 产生、经 SDK `session.status` 通知与 `session.status` 协议消息送达。
 * 早先界面用 `turn.status === 'running'` 推导——一旦 `turn/end` 在侧信道重连窗口里丢失，
 * turn 会永久停在 running，界面就卡在「正在执行任务」。所以这里只认宿主说的话。
 *
 * 缺键表示**未知**（不得当作运行中）：新会话在第一条状态通知到达前就是未知。
 */
export interface SessionStatusStore {
  readonly statuses: Readonly<Record<string, 'idle' | 'running'>>
  apply: (payload: SessionStatus) => void
  reset: () => void
}

export const useSessionStatusStore = create<SessionStatusStore>((set) => ({
  statuses: {},
  apply: (payload) =>
    set((state) => {
      // 值未变化时返回原 state：zustand 会跳过通知，订阅方因此只看到**真实跃迁**。
      if (state.statuses[payload.sessionId] === payload.status) return state
      return { statuses: { ...state.statuses, [payload.sessionId]: payload.status } }
    }),
  reset: () => set({ statuses: {} }),
}))

/** 某会话是否正在运行；未知与 `null` 一律按 `false`（宁可少报执行中，不可假报）。 */
export function isSessionRunning(sessionId: string | null): boolean {
  return sessionId !== null && useSessionStatusStore.getState().statuses[sessionId] === 'running'
}
