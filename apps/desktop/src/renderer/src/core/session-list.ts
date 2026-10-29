import type { SessionSummary } from '@dexagent/shared'
import { reconcileManualOrder, UNGROUPED_ORDER_KEY } from './sidebar-order'
import type { TurnRecord } from './trace'
import type { WorkspaceRecord } from './workspaces'
import {
  normalizeWorkspacePath,
  workspaceId as workspaceIdForPath,
  workspaceName as workspaceNameForPath,
} from './workspaces'

/** 会话列表 UI 索引（置顶 / 隐藏），与 sessionStore 的持久化形状一致。 */
export interface SessionListIndex {
  readonly pinned: readonly string[]
  readonly hidden: readonly string[]
}

/**
 * 由当前 trace 的 turns 推导会话状态（原 SessionPanel 内联逻辑）。
 * 末轮 failed → failed；completed → completed；其余（含无轮次）→ running。
 */
export function deriveSessionStatus(turns: readonly TurnRecord[]): SessionSummary['status'] {
  const last = turns.at(-1)
  if (last?.status === 'failed') return 'failed'
  if (last?.status === 'completed') return 'completed'
  return 'running'
}

/**
 * 可复用的空白会话：照抄 dsh `connectWorkspace` 的四判据
 * （`F:\DSH\deepseek-harness\packages\client\ui-workspace\src\client\navigation.ts:137-159`）——
 * blank && cwd 与工作区路径相等 && 是该工作区成员 && 未归档（Dex 口径：未隐藏）。
 *
 * cwd 是归属权威（`workspace/workspace/src/entity.ts:101`）；缺 cwd（真孤儿）时退回
 * 本地别名——那是 FIX-018 之后 `sessionWorkspace` 仅剩的语义。
 */
export function findReusableBlankSession(input: {
  readonly sessions: readonly SessionSummary[]
  readonly sessionWorkspace: Readonly<Record<string, string>>
  readonly workspaceId: string
  readonly workspacePath: string
}): SessionSummary | null {
  const normalizedPath = normalizeWorkspacePath(input.workspacePath)
  if (input.workspaceId !== workspaceIdForPath(normalizedPath)) return null
  return (
    input.sessions.find((session) => {
      if (session.blank !== true) return false
      return session.cwd !== undefined
        ? normalizeWorkspacePath(session.cwd) === normalizedPath
        : input.sessionWorkspace[session.sessionId] === input.workspaceId
    }) ?? null
  )
}

/**
 * 「当前会话未入库」时合成一条临时 Summary，插入其所属工作区分组头部。
 * 已在历史里（或无活跃会话）时返回 null。
 *
 * 还没跑过任何一轮时它就是 dsh 的**「新会话」占位行**（`tree.ts:214-221` 的
 * 「New Session / 新会话」）：`blank: true` 让它不可拖拽、不进手动顺序；
 * 不显示相对时间由渲染层按 blank 跳过。
 */
export function synthesizeActiveSession(input: {
  readonly activeSessionId: string
  readonly turns: readonly TurnRecord[]
  readonly existing: readonly SessionSummary[]
  readonly workspaceId: string
  readonly sessionWorkspace: Readonly<Record<string, string>>
}): SessionSummary | null {
  if (input.sessionWorkspace[input.activeSessionId] !== input.workspaceId) return null
  if (input.existing.some((item) => item.sessionId === input.activeSessionId)) return null
  const sessionTurns = input.turns.filter((turn) => turn.id.startsWith(`${input.activeSessionId}:`))
  const last = sessionTurns.at(-1)
  const blank = sessionTurns.length === 0
  return {
    sessionId: input.activeSessionId,
    title: blank ? '新会话' : '当前会话',
    status: deriveSessionStatus(sessionTurns),
    taskCount: sessionTurns.length,
    blank,
    ...(last?.endedAt === undefined ? {} : { updatedAt: last.endedAt }),
  }
}

/**
 * 会话列表的可见集：按 sessionId 去重 → 滤掉隐藏 → **空白会话只留当前那条** →
 * 按查询词过滤（标题 / id 包含）→ 置顶优先，再按 updatedAt 降序。
 *
 * 空白会话的显示口径照 dsh：全局只显示**当前选中**的那一条 blank，其余隐藏
 * （`tree.ts:202-212`）；搜索时 blank 全部排除（`tree.ts:461-465`）。
 */
export type ArchivedFilter = 'default' | 'show' | 'only'

export function selectVisibleSessions(input: {
  readonly sessions: readonly SessionSummary[]
  readonly index: SessionListIndex
  readonly query?: string
  readonly activeSessionId?: string | null
  /** 宿主权威的归档集合（workspace 门域）。 */
  readonly archivedIds?: readonly string[]
  /** 归档可见性（照 dsh `tree.ts` 的 default/show/only；搜索同样跟随）。 */
  readonly archivedFilter?: ArchivedFilter
}): SessionSummary[] {
  const query = (input.query ?? '').trim().toLowerCase()
  const activeSessionId = input.activeSessionId ?? null
  const archived = new Set(input.archivedIds ?? [])
  const archivedFilter = input.archivedFilter ?? 'default'
  return [...new Map(input.sessions.map((item) => [item.sessionId, item])).values()]
    .filter((item) => {
      const isArchived = archived.has(item.sessionId)
      if (archivedFilter === 'only') return isArchived
      if (archivedFilter === 'show') return true
      return !isArchived
    })
    .filter(
      (item) =>
        item.blank !== true ||
        (query === '' && activeSessionId !== null && item.sessionId === activeSessionId),
    )
    .filter(
      (item) =>
        query === '' ||
        item.title.toLowerCase().includes(query) ||
        item.sessionId.toLowerCase().includes(query),
    )
    .sort((left, right) => {
      const leftPinned = input.index.pinned.includes(left.sessionId) ? 0 : 1
      const rightPinned = input.index.pinned.includes(right.sessionId) ? 0 : 1
      return leftPinned - rightPinned || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    })
}

export interface WorkspaceSessionGroup {
  readonly workspace: WorkspaceRecord
  readonly sessions: SessionSummary[]
}

/**
 * 组内手动顺序（UI-06b）：有保存顺序时用 `reconcileManualOrder` 对账，
 * 没有时保持 `selectVisibleSessions` 的「置顶 → 最近使用」原序。
 */
function applyAccountOrder(
  sessions: readonly SessionSummary[],
  savedOrder: readonly string[] | undefined,
  pinnedIds: readonly string[] | undefined,
): SessionSummary[] {
  if (savedOrder === undefined) return [...sessions]
  const summaries = Object.fromEntries(sessions.map((session) => [session.sessionId, session]))
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  return reconcileManualOrder({
    memberIds: sessions.map((session) => session.sessionId),
    savedOrder,
    summaries,
    pinnedIds: pinnedIds ?? [],
  }).flatMap((id) => {
    const session = byId.get(id)
    return session === undefined ? [] : [session]
  })
}

/**
 * 会话归属的**唯一判据**：cwd 规范化后与工作区路径相等 —— 照抄 dsh 的
 * `WorkspaceEntity.sessionIds`（`F:\DSH\deepseek-harness\packages\workspace\workspace\src\entity.ts:101`，
 * `sessionIds = record.sessionIds.filter(id => host.sessionPath(id) === record.path)`）。
 *
 * 本地索引 `sessionWorkspace` **不再决定归属**，只在 cwd 无法判定（无 cwd / 目录已不存在）
 * 时当**本地别名**兜底：它承载的是「用户自己想把它归在哪」，不是「dsh 说它属于哪」。
 */
function owningWorkspaceId(
  session: SessionSummary,
  workspaces: readonly WorkspaceRecord[],
  sessionWorkspace: Readonly<Record<string, string>>,
): string | null {
  if (session.cwd !== undefined) {
    const normalized = normalizeWorkspacePath(session.cwd)
    const hit = workspaces.find((workspace) => workspace.path === normalized)
    if (hit !== undefined) return hit.id
  }
  // 别名必须指向**现存**工作区：目标已被删除（忽略表）时按真孤儿处理，
  // 否则会话会掉进一个不存在的分组里凭空消失。
  const alias = sessionWorkspace[session.sessionId]
  if (alias === undefined) return null
  return workspaces.find((workspace) => workspace.id === alias)?.id ?? null
}

/**
 * 会话按工作区分组。
 *
 * 工作区列表 = **已登记的** ∪ **从会话 cwd 推导出的**。后者不落盘（`lastUsedAt` 取该组
 * 最新会话时间，只用于排序），用户真正在这个目录上开过会话时才会被 `registerWorkspace` 收进
 * 本地索引 —— 这样新会话的历史不会把侧栏越撑越大。
 *
 * 掉进「未分组」的只剩真孤儿：cwd 缺失或目录已不存在（与 dsh 的 `sessionPath` 语义一致）。
 */
export function groupSessionsByWorkspace(input: {
  readonly visible: readonly SessionSummary[]
  readonly registered: readonly WorkspaceRecord[]
  readonly sessionWorkspace: Readonly<Record<string, string>>
  readonly query?: string
  readonly activeSessionId?: string | null
  readonly activeTurns?: readonly TurnRecord[]
  /** 账号（工作区 id / `UNGROUPED_ORDER_KEY`）→ 手动顺序；缺省 = 默认排序。 */
  readonly orderByAccount?: Readonly<Record<string, readonly string[]>>
  readonly pinnedIds?: readonly string[]
  /** 本地忽略表：已删除的工作区路径不再参与分组与推导（会话落未分组）。 */
  readonly ignoredPaths?: readonly string[]
}): {
  readonly groups: readonly WorkspaceSessionGroup[]
  readonly unassigned: readonly SessionSummary[]
} {
  const query = (input.query ?? '').trim().toLowerCase()
  const ignored = new Set((input.ignoredPaths ?? []).map((path) => normalizeWorkspacePath(path)))
  const workspaces: WorkspaceRecord[] = [...input.registered].filter(
    (workspace) => !ignored.has(workspace.path),
  )
  const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))

  for (const session of input.visible) {
    if (session.cwd === undefined) continue
    const path = normalizeWorkspacePath(session.cwd)
    if (byPath.has(path) || ignored.has(path)) continue
    const newest = Math.max(
      0,
      ...input.visible
        .filter((item) => item.cwd !== undefined && normalizeWorkspacePath(item.cwd) === path)
        .map((item) => item.updatedAt ?? 0),
    )
    // 标题取**原始 cwd** 的最后一段（dsh `workspaceTitleOf` 同法），而不是规范化后的
    // —— 规范化会把 Windows 路径转小写，`dexAgent` 就会变成 `dexagent`。
    const name = workspaceNameForPath(
      input.visible.find(
        (item) => item.cwd !== undefined && normalizeWorkspacePath(item.cwd) === path,
      )?.cwd ?? path,
    )
    const workspace: WorkspaceRecord = {
      id: workspaceIdForPath(path),
      path,
      name,
      lastUsedAt: newest,
    }
    workspaces.push(workspace)
    byPath.set(path, workspace)
  }

  const groups = workspaces
    .filter(
      (workspace) =>
        query === '' ||
        workspace.name.toLowerCase().includes(query) ||
        workspace.path.toLowerCase().includes(query),
    )
    .map((workspace) => {
      const sessions = applyAccountOrder(
        input.visible.filter(
          (session) =>
            owningWorkspaceId(session, workspaces, input.sessionWorkspace) === workspace.id,
        ),
        input.orderByAccount?.[workspace.id],
        input.pinnedIds,
      )
      if (
        input.activeSessionId !== undefined &&
        input.activeSessionId !== null &&
        input.activeTurns !== undefined
      ) {
        const synthesized = synthesizeActiveSession({
          activeSessionId: input.activeSessionId,
          turns: input.activeTurns,
          existing: sessions,
          workspaceId: workspace.id,
          sessionWorkspace: input.sessionWorkspace,
        })
        if (synthesized !== null) sessions.unshift(synthesized)
      }
      return { workspace, sessions }
    })
  const unassigned = applyAccountOrder(
    input.visible.filter(
      (session) => owningWorkspaceId(session, workspaces, input.sessionWorkspace) === null,
    ),
    input.orderByAccount?.[UNGROUPED_ORDER_KEY],
    input.pinnedIds,
  )
  return { groups, unassigned }
}
