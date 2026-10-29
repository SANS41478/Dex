import { z } from 'zod'
import { traceStateSchema } from './trace'

export const sessionEventSchema = z.object({
  type: z.string().min(1),
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  data: z.unknown(),
})
export type SessionEventRecord = z.infer<typeof sessionEventSchema>

export const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'unknown']),
  taskCount: z.number().int().nonnegative(),
  /** True until the session has started its first accepted turn. */
  blank: z.boolean().optional(),
  lastEventAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  /**
   * 会话头里的 `cwd`，经 `fs.realpath` 规范化，且**已确认指向真实存在的目录**。
   *
   * 只增字段（2026-10-07）。**这是会话归属的权威事实**：dsh 自己就是用它算归属的——
   * `packages/workspace/workspace/src/entity.ts:101` 的
   * `sessionIds = record.sessionIds.filter(id => host.sessionPath(id) === record.path)`，
   * 而 `sessionPath` 在「header 缺失或 cwd 无法解析到现存目录」时返回 `undefined`。
   * 我们此前没有透出它，分组只能靠客户端本地索引（`dex.workspaces.v1`），
   * 于是「不是经由本客户端 create/activate 过的会话」全部掉进未归档桶——
   * 哪怕它的工作区明明白白写在 cwd 里。
   *
   * **缺省 = 真孤儿**：无 cwd、或目录已不存在。这与 dsh 的语义完全一致。
   */
  cwd: z.string().min(1).optional(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const sessionListSchema = z.object({
  sessions: z.array(sessionSummarySchema),
  nextCursor: z.string().min(1).optional(),
})
export type SessionList = z.infer<typeof sessionListSchema>

export const sessionReplaySchema = z.object({
  sessionId: z.string().min(1),
  traceState: traceStateSchema,
})
export type SessionReplay = z.infer<typeof sessionReplaySchema>

/**
 * 物理删除一条**无工作区归属**的会话日志的回执。
 *
 * dsh 持久层没有删除接口，只有“日志累积到外部移除”的约定；这里只暴露
 * “是否真的移除了日志文件”，不把磁盘路径带回 renderer。
 */
export const sessionDeleteResultSchema = z.object({
  deleted: z.literal(true),
  removedLog: z.boolean(),
})
export type SessionDeleteResult = z.infer<typeof sessionDeleteResultSchema>

type EventLike = SessionEventRecord

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textOf(value: unknown): string {
  const record = recordOf(value)
  const content = record?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => recordOf(block)?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
}

function eventTitle(events: readonly EventLike[]): string | null {
  // `session/title` 是 **last-wins**（dsh 的 title 投影语义）：用户重命名会追加新事件，
  // 取第一条会把自动标题当成最终标题，重命名永远不显示。
  const explicit = events
    .filter((event) => event.type === 'session/title')
    .map((event) => recordOf(event.data)?.title)
    .findLast((title): title is string => typeof title === 'string' && title.trim() !== '')
  if (explicit !== undefined) return explicit.trim()
  const prompt = events
    .filter((event) => event.type === 'user/message')
    .map((event) => textOf(event.data))
    .find((text) => text.trim() !== '')
  return prompt?.trim() || null
}

export function summarizeSessionEvents(
  sessionId: string,
  events: readonly EventLike[],
  createdAt?: number,
  /** 会话头的 cwd（已 realpath 规范化并确认目录存在）；缺省 = 真孤儿，见 `sessionSummarySchema.cwd`。 */
  cwd?: string,
): SessionSummary {
  const sorted = [...events].sort((left, right) => left.seq - right.seq)
  let openTurns = 0
  let completedTurns = 0
  let failedTurns = 0
  for (const event of sorted) {
    if (event.type === 'turn/start') openTurns += 1
    if (event.type !== 'turn/end') continue
    openTurns = Math.max(0, openTurns - 1)
    const reason = recordOf(event.data)?.reason
    const kind = recordOf(reason)?.kind
    if (kind === 'completed') completedTurns += 1
    else failedTurns += 1
  }
  const lastEventAt = sorted.at(-1)?.time
  const status =
    openTurns > 0
      ? 'running'
      : failedTurns > 0
        ? 'failed'
        : completedTurns > 0
          ? 'completed'
          : 'unknown'
  const title = eventTitle(sorted) ?? sessionId
  return {
    sessionId,
    title: title.slice(0, 160),
    status,
    taskCount: completedTurns + failedTurns + openTurns,
    blank: sorted.every((event) => event.type !== 'turn/start'),
    ...(cwd === undefined ? {} : { cwd }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...((lastEventAt ?? createdAt) === undefined ? {} : { updatedAt: lastEventAt ?? createdAt }),
  }
}

export function sortSessionSummaries(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    return timeDelta !== 0 ? timeDelta : left.sessionId.localeCompare(right.sessionId)
  })
}
