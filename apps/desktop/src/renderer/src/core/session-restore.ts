/**
 * 「上次打开的会话」的本地持久化（key `dex.active-session.v1`）。
 *
 * 为什么需要：工作区能恢复、会话不能——刷新（或 dev 热重载）之后界面回到欢迎态，
 * 输入框锁在 `先创建一个会话…`，用户得手动再点一次会话（黑盒报告 D08）。
 *
 * 只存**指针**（会话 id + 工作区路径），不存任何会话内容：内容的事实源始终是 dsh 的
 * 会话日志，这里只是一个「上次看到哪儿」的书签。恢复失败（会话被删、宿主不认）时
 * 调用方应当把书签清掉，别每次启动都白试一遍。
 */
export const ACTIVE_SESSION_STORAGE_KEY = 'dex.active-session.v1'

export interface RestorableSession {
  readonly sessionId: string
  readonly workspacePath: string
}

export function parseRestorableSession(raw: string | null): RestorableSession | null {
  if (raw === null || raw === '') return null
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return null
    const input = value as { sessionId?: unknown; workspacePath?: unknown }
    if (typeof input.sessionId !== 'string' || input.sessionId === '') return null
    if (typeof input.workspacePath !== 'string' || input.workspacePath === '') return null
    return { sessionId: input.sessionId, workspacePath: input.workspacePath }
  } catch {
    return null
  }
}

export function serializeRestorableSession(value: RestorableSession | null): string {
  return JSON.stringify(value)
}

/**
 * 写入书签。**刻意做成「失败也不报错」**：它只是便利设施，不该因为浏览器隐私模式或
 * 配额问题把激活会话这条主流程带崩；`typeof localStorage` 的判断则让这个模块在
 * 没有 DOM 的单测环境里也能安全调用。
 */
export function rememberActiveSession(value: RestorableSession | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (value === null) localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
    else localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, serializeRestorableSession(value))
  } catch {
    // 忽略：书签丢了大不了下次启动回到欢迎态。
  }
}

export function readRestorableSession(): RestorableSession | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return parseRestorableSession(localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY))
  } catch {
    return null
  }
}
