import type { TurnRecord } from '@dexagent/shared'

export type ChatTimelineRole = 'user' | 'assistant' | 'system' | 'error' | 'pending'

export interface ChatTimelineMessage {
  readonly id: string
  readonly role: ChatTimelineRole
  readonly content: string
  readonly status: 'pending' | 'completed' | 'failed'
  readonly createdAt: number
}

export interface LocalChatMessage {
  readonly id: string
  readonly role: 'user' | 'system'
  readonly content: string
  readonly status: 'completed' | 'failed'
  readonly createdAt: number
}

/**
 * 合成状态行（`pending` / `error`）的**排序键**，与 `createdAt` 分开。
 *
 * 为什么必须分开：`createdAt` 既要参与排序，又要在界面上渲染成日期分隔与时间标签。
 * 早先的实现把两者混为一谈，并且直接取 `options.now ?? Date.now()` 当排序时间戳——
 * 于是每渲染一次就换一个「现在」，合成行**永远排到最后**，用户看到的就是
 * 「模型回复之后又跳回正在执行任务」。
 *
 * 现在的分工：`createdAt` 保留真实时刻（供显示），排序改用常量键。
 * 常量必须大于任何真实事件时刻，合成行的相对顺序由常量大小决定（pending 在 error 之前）。
 */
const SYNTHETIC_PENDING_ORDER = Number.MAX_SAFE_INTEGER - 1
const SYNTHETIC_ERROR_ORDER = Number.MAX_SAFE_INTEGER

/**
 * 失败轮次的可见文案；宿主没给出任何原因时返回 `null`（不凭空造一条错误行）。
 *
 * **判据是「宿主给了原因」而不是「status === 'failed'」**：`turn/end` 的非 completed
 * 取值里既有错误（`error`），也有用户主动停止（`aborted`）等正常收尾，把后者也渲染成
 * 红色错误行会误导。dsh 只在真出错时带 `reason.error`，所以用它当判据最准。
 */
function formatTurnFailure(turn: TurnRecord): string | null {
  const message = turn.failureMessage?.trim() ?? ''
  const code = turn.failureCode?.trim() ?? ''
  if (message === '' && code === '') return null
  if (message === '') return `执行失败（${code}）`
  return code === '' ? message : `${message}（${code}）`
}

interface TimelineRow {
  readonly message: ChatTimelineMessage
  /** 排序主键：真实消息用 `createdAt`，合成行用上面的常量。 */
  readonly order: number
  readonly roleOrder: number
}

export function buildChatTimeline(
  localMessages: readonly LocalChatMessage[],
  turns: readonly TurnRecord[],
  options: {
    readonly pending: boolean
    readonly error: string | null
    /** 本轮开始时刻：仅用于「正在执行任务」气泡的**显示**时间，不参与排序。 */
    readonly pendingStartedAt?: number | undefined
    readonly now?: number
  },
): ChatTimelineMessage[] {
  const consumedLocal = new Set<string>()
  const orderedTurns = [...turns].sort((left, right) => left.startedAt - right.startedAt)
  const rows: TimelineRow[] = []
  const roleOrder: Record<ChatTimelineRole, number> = {
    user: 0,
    assistant: 1,
    pending: 2,
    system: 3,
    error: 4,
  }
  const push = (message: ChatTimelineMessage, order = message.createdAt): void => {
    rows.push({ message, order, roleOrder: roleOrder[message.role] })
  }

  for (const turn of orderedTurns) {
    if (turn.userMessage.trim() !== '') {
      const matchingLocal = localMessages.find(
        (message) =>
          message.role === 'user' &&
          !consumedLocal.has(message.id) &&
          message.content === turn.userMessage,
      )
      if (matchingLocal !== undefined) consumedLocal.add(matchingLocal.id)
      push({
        id: `${turn.id}:user`,
        role: 'user',
        content: turn.userMessage,
        status: 'completed',
        createdAt: turn.startedAt,
      })
    }
    const assistantMessage = turn.assistantMessage
    if (assistantMessage !== undefined && assistantMessage.trim() !== '') {
      push({
        id: `${turn.id}:assistant`,
        role: 'assistant',
        content: assistantMessage,
        status: turn.status === 'failed' ? 'failed' : 'completed',
        createdAt: turn.endedAt ?? turn.startedAt + 1,
      })
    }
    // 失败原因排在同一个 turn 的末尾：assistant 行（roleOrder 1）先于 error 行（roleOrder 4）。
    const failure = formatTurnFailure(turn)
    if (failure !== null) {
      push({
        id: `${turn.id}:failure`,
        role: 'error',
        content: failure,
        status: 'failed',
        createdAt: turn.endedAt ?? turn.startedAt + 1,
      })
    }
  }

  for (const message of localMessages) {
    if (consumedLocal.has(message.id)) continue
    push({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
    })
  }

  if (options.pending) {
    push(
      {
        id: 'pending:assistant',
        role: 'pending',
        content: '正在执行任务…',
        status: 'pending',
        createdAt: options.pendingStartedAt ?? options.now ?? Date.now(),
      },
      SYNTHETIC_PENDING_ORDER,
    )
  }
  if (options.error !== null) {
    push(
      {
        id: 'error:latest',
        role: 'error',
        content: options.error,
        status: 'failed',
        createdAt: options.now ?? Date.now(),
      },
      SYNTHETIC_ERROR_ORDER,
    )
  }

  return rows
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.roleOrder - right.roleOrder ||
        left.message.id.localeCompare(right.message.id),
    )
    .map((row) => row.message)
}
