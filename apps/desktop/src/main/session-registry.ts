import type { AppError } from '@dexagent/shared'

/**
 * 该会话的 prompt 走哪条通道。
 *
 * - `stdio`：本进程用 SDK 新建的会话，`session/prompt` 能接住（dsh 的 SDK 服务器
 *   手里有这个 id 的记录）。
 * - `control`：从磁盘恢复的历史会话，只能走 `/dex-control`。宿主侧在**打开会话**
 *   时就 `ctx.agents.resume({ resumeSessionId })` 把它复活（D33），
 *   之后 `/dex-control` 的 `sessions/prompt` 才能投递。
 *
 * 为什么必须区分：SDK 的 `session/prompt` 是 `getOrCreateSession` → **只 create、
 * 不 resume**，撞上磁盘上的同名会话就抛 `SessionAlreadyExistsError`。
 */
export type SessionChannel = 'stdio' | 'control'

/**
 * 本进程登记的活跃会话。
 *
 * `control` 通道的会话不再受 「能力上限」约束：当时结论是「磁盘上已存在、
 * 本进程没登记过的会话无法继续对话」，因为只考虑了 SDK stdio 面。控制桥补上了
 * `agents.resume` 这条路，且登记发生在**宿主侧 resume 成功之后**——所以「在登记表里」
 * 依然等价于「能继续对话」，只是背后的机制换了。
 */
export interface ActiveSession {
  readonly sessionId: string
  readonly workspacePath: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly channel: SessionChannel
  busy: boolean
}

/** 会话存在但不可继续（历史会话只能只读回放）。 */
export const SESSION_NOT_RESUMABLE_CODE = 'SESSION_NOT_RESUMABLE'
export const SESSION_NOT_RESUMABLE_MESSAGE =
  '该会话是历史记录，只能只读回放，不能继续对话；请新建会话。'

export function sessionNotResumableError(sessionId: string): AppError {
  return {
    code: SESSION_NOT_RESUMABLE_CODE,
    message: `${SESSION_NOT_RESUMABLE_MESSAGE}（${sessionId}）`,
    retryable: false,
  }
}

export function sessionBusyError(): AppError {
  return { code: 'SESSION_BUSY', message: '当前会话正在执行任务', retryable: true }
}

/**
 * dsh 侧 `session/prompt` 失败的收口。
 *
 * 正常路径下前端不会走到这里（`activate` 已经拦掉未登记的 id）；保留这层映射是
 * 纵深防御：dsh 宿主若在本进程存续期间重启（句柄/热重载），登记表会与宿主内存脱节，
 * 此时 `already exists` 必须变成可读的产品错误，而不是把 dsh 内部消息透给用户。
 */
export function mapPromptFailure(error: unknown, sessionId: string): AppError {
  const message = error instanceof Error ? error.message : '发送任务失败'
  if (/already exists/.test(message)) return sessionNotResumableError(sessionId)
  return { code: 'PROMPT_FAILED', message, retryable: true }
}

/**
 * 历史会话恢复（`/dex-control` → `sessions/resume`）失败的收口。
 *
 * 恢复在「打开会话」时发生，失败要就地退化——renderer 的 `SessionPanel` 已经在
 * `activate` 的 catch 分支里准备了「只读回放 + 一句说明」。所以这里的目标是：
 * **凡是「这个会话续不了」的情形，都归到 `SESSION_NOT_RESUMABLE`**，把用户看不懂的
 * dsh 内部措辞挡在门外。
 *
 * 能明确归类的是两种：宿主里已经有同 id 的活体（`agent "…" is already registered`
 * / 持久化写占用被别的持有者占着），以及会话在磁盘上不存在。其余错误保留原始消息
 * 并标成可重试——比如「会话持久化未配置」属于环境问题，说清楚比吞掉有用。
 */
export function mapResumeFailure(error: unknown, sessionId: string): AppError {
  const message = error instanceof Error ? error.message : '恢复历史会话失败'
  if (/already registered|already exists|write claim|is locked|ENOENT|no such/i.test(message)) {
    return sessionNotResumableError(sessionId)
  }
  return { code: 'SESSION_RESUME_FAILED', message, retryable: true }
}

/**
 * 停止（`/dex-control` → `sessions/cancel`）失败的收口。
 *
 * 最常见的两种：宿主侧压根没有该会话的活跃 Agent（已经跑完 / 从未启动），以及控制通道
 * 连不上（宿主冷启动或已退出）。前者对用户而言等价于「已经不在执行」，故标记可重试让
 * 界面按基线刷新即可，不把它包装成硬失败。
 */
export function mapStopFailure(error: unknown): AppError {
  const message = error instanceof Error ? error.message : '停止任务失败'
  return { code: 'STOP_FAILED', message, retryable: true }
}

/**
 * 活跃会话登记表。持有会话记录、当前活跃 id 与会话序号生成；
 * 不含 Electron / dsh 依赖，行为可用单测覆盖。
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, ActiveSession>()
  #activeSessionId: string | null = null
  #sequence = 0

  get activeSessionId(): string | null {
    return this.#activeSessionId
  }

  /** 生成会话 id：`dex-<毫秒时间戳>-<本次运行内递增序号>`。 */
  nextSessionId(now: number = Date.now()): string {
    this.#sequence += 1
    return `dex-${now}-${String(this.#sequence)}`
  }

  register(session: ActiveSession): void {
    this.#sessions.set(session.sessionId, session)
    this.#activeSessionId = session.sessionId
  }

  find(sessionId: string): ActiveSession | undefined {
    return this.#sessions.get(sessionId)
  }

  /** 该 id 是否登记在本进程（`channel` 决定 prompt 走哪条通道）。 */
  resumable(sessionId: string): boolean {
    return this.#sessions.has(sessionId)
  }

  /**
   * 切换活跃会话前的守卫（不改动任何状态）。
   *
   * 存在的意义是让调用方**先把代价高昂的动作做完再切换**：打开历史会话要先在宿主侧
   * resume 成功才值得登记，而 resume 可能耗时数秒；若先切换再 resume，失败回滚就得
   * 动活跃指针。`activate` 内部复用同一判定，两条路径不会漂移。
   * @returns 失败原因；可以切换时为 `null`。
   */
  canActivate(): AppError | null {
    const current =
      this.#activeSessionId === null ? undefined : this.#sessions.get(this.#activeSessionId)
    return current?.busy === true ? sessionBusyError() : null
  }

  /**
   * 把某个会话设为活跃会话。
   * @param adopt 未登记的 id 的补登记内容（`control` 通道的历史会话）。**必须在宿主侧
   *   resume 成功之后才传**——登记表是「能继续对话」的判据，先登记后恢复会让这个判据
   *   变成谎话。不传 `adopt` 时，未登记的 id 仍然如实拒绝（只读回放的判据）。
   * @returns 失败原因；成功时为 `null`。
   */
  activate(sessionId: string, adopt?: Omit<ActiveSession, 'busy'>): AppError | null {
    const existing = this.#sessions.get(sessionId)
    if (existing === undefined && adopt === undefined) return sessionNotResumableError(sessionId)
    const blocked = this.canActivate()
    if (blocked !== null) return blocked
    if (existing === undefined && adopt !== undefined) {
      this.#sessions.set(sessionId, { ...adopt, busy: false })
    }
    this.#activeSessionId = sessionId
    return null
  }
}
