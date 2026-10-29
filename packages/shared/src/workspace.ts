import { z } from 'zod'

/**
 * 工作区视图（照 dsh `WorkspaceView` 的只读投影）。
 *
 * 与 dsh 的差异：`title` 由宿主工作区登记决定；`sessionIds` 是**宿主记账**的成员
 * （cwd 相等才真正生效，见 dsh `entity.ts:101`），Dex 侧栏分组仍以 cwd 推导为准，
 * 该字段用于「打开/管理宿主登记」场景。
 */
export const workspaceViewSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  sessionIds: z.array(z.string()),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
})
export type WorkspaceView = z.infer<typeof workspaceViewSchema>

/** 工作区全量快照：登记表 + 全局顺序 + 归档/置顶会话集合（workspace 门域状态）。 */
export const workspaceListSchema = z.object({
  workspaces: z.array(workspaceViewSchema),
  workspaceIds: z.array(z.string()),
  archivedSessionIds: z.array(z.string()),
  pinnedSessionIds: z.array(z.string()),
})
export type WorkspaceList = z.infer<typeof workspaceListSchema>

export const workspaceCreateResultSchema = z.object({
  workspace: workspaceViewSchema,
  created: z.boolean(),
})
export type WorkspaceCreateResult = z.infer<typeof workspaceCreateResultSchema>

export const workspaceRenameResultSchema = z.object({ workspace: workspaceViewSchema })
export type WorkspaceRenameResult = z.infer<typeof workspaceRenameResultSchema>

export const workspaceDeleteResultSchema = z.object({ deleted: z.literal(true) })
export type WorkspaceDeleteResult = z.infer<typeof workspaceDeleteResultSchema>

export const workspaceOrderResultSchema = z.object({ workspaceIds: z.array(z.string()) })
export type WorkspaceOrderResult = z.infer<typeof workspaceOrderResultSchema>

/** `session/rename` 的宿主应答（title 已规范化，seq 是标题事件的序号）。 */
export const sessionRenameResultSchema = z.object({
  title: z.string().min(1),
  seq: z.number().int().nonnegative(),
})
export type SessionRenameResult = z.infer<typeof sessionRenameResultSchema>

/** 归档/取消归档后的全局归档集合（宿主权威）。 */
export const archivedSessionsResultSchema = z.object({
  archivedSessionIds: z.array(z.string()),
})
export type ArchivedSessionsResult = z.infer<typeof archivedSessionsResultSchema>

/** 置顶/取消置顶后的全局置顶集合（宿主权威）。 */
export const pinnedSessionsResultSchema = z.object({
  pinnedSessionIds: z.array(z.string()),
})
export type PinnedSessionsResult = z.infer<typeof pinnedSessionsResultSchema>
