import {
  modelDiscoveryRequestSchema,
  modelSelectionSchema,
  settingsMutateRequestSchema,
} from '@dexagent/shared'
import { z } from 'zod'

export type {
  ArchivedSessionsResult,
  ConfigurableProvider,
  DiscoveredModel,
  ModelCatalog,
  ModelDiscoveryRequest,
  ModelSelection,
  PinnedSessionsResult,
  PluginBundleInfo,
  PluginChangeResult,
  PluginFiberPhase,
  PluginInfo,
  PluginReadOnlyReason,
  PluginsList,
  SessionDeleteResult,
  SessionList,
  SessionRenameResult,
  SessionReplay,
  SessionSummary,
  SettingsDescribe,
  SettingsMutateRequest,
  SettingsNamespace,
  SettingsPathOperation,
  WorkspaceCreateResult,
  WorkspaceDeleteResult,
  WorkspaceList,
  WorkspaceOrderResult,
  WorkspaceRenameResult,
  WorkspaceView,
} from '@dexagent/shared'
export {
  archivedSessionsResultSchema,
  discoveredModelSchema,
  modelCatalogSchema,
  modelDiscoveryRequestSchema,
  modelSelectionSchema,
  pinnedSessionsResultSchema,
  pluginBundleInfoSchema,
  pluginChangeResultSchema,
  pluginFiberPhaseSchema,
  pluginInfoSchema,
  pluginReadOnlyReasonSchema,
  pluginsListSchema,
  pluginsSetEnabledRequestSchema,
  sessionDeleteResultSchema,
  sessionListSchema,
  sessionRenameResultSchema,
  sessionReplaySchema,
  settingsDescribeSchema,
  settingsMutateRequestSchema,
  settingsMutateResultSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceListSchema,
  workspaceOrderResultSchema,
  workspaceRenameResultSchema,
} from '@dexagent/shared'

export const controlRequestSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('models/list'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
  }),
  z.object({
    method: z.literal('models/select'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    selection: modelSelectionSchema,
  }),
  z.object({
    method: z.literal('credentials/set'),
    requestId: z.string().min(1),
    provider: z.string().min(1),
    apiKey: z.string().min(1),
  }),
  z.object({
    method: z.literal('credentials/unset'),
    requestId: z.string().min(1),
    provider: z.string().min(1),
  }),
  z.object({
    method: z.literal('sessions/list'),
    requestId: z.string().min(1),
    cursor: z.string().min(1).optional(),
  }),
  z.object({
    method: z.literal('sessions/replay'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /**
   * 取消一个活跃 Agent 的当前轮次（dsh `agent.cancel({kind:'user'}, {keepInbox:true})`）。
   *
   * SDK stdio 面没有 cancel 方法（`handleRequest` 是封闭 switch），所以这一条只能走控制桥。
   * 无活跃活动时 dsh 侧是 no-op——重复取消不会报错。
   */
  z.object({
    method: z.literal('sessions/cancel'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /**
   * 把磁盘上的历史会话恢复成活体（D33）：`ctx.agents.resume({ resumeSessionId })`。
   *
   * 这是 SDK stdio 面**结构上做不到**的事——它的 `session/prompt` 走
   * `getOrCreateSession` → 只 `create`、不 `resume`，撞上磁盘上已存在的同名会话即抛
   * `SessionAlreadyExistsError`。所以「续聊历史会话」只能由控制桥完成。
   *
   * 幂等：该 id 已经是活体（本进程新建或已恢复过）时直接返回当前模型，不重复 resume
   * ——重复 resume 会撞上持久化的写占用而失败。
   */
  z.object({
    method: z.literal('sessions/resume'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    /** 恢复后该会话使用的模型；缺省则交给 dsh 的默认模型。 */
    selection: modelSelectionSchema.optional(),
  }),
  /**
   * 往**已经活起来**的会话投递一条用户消息（D33）。
   *
   * 与 `sessions/resume` 拆成两个方法是刻意的：恢复的代价（读整份会话日志、拿写占用、
   * 可能需要 crash 修复）应当发生在「打开会话」这一步，失败就地退化为只读回放；
   * 投递本身只负责把消息推进 inbox。
   */
  z.object({
    method: z.literal('sessions/prompt'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    content: z.string().min(1),
    /**
     * 交付方式。`followup`（默认）= 开一轮普通的新对话；`steer` = 插进当前轮次的
     * 下一个 step 边界（dsh `agent.steer`）。当前渲染端只发 `followup`。
     */
    mode: z.enum(['followup', 'steer']).optional(),
  }),
  z.object({
    method: z.literal('settings/describe'),
    requestId: z.string().min(1),
  }),
  z.object({
    method: z.literal('settings/mutate'),
    requestId: z.string().min(1),
    namespace: z.string().min(1),
    operations: settingsMutateRequestSchema.shape.operations,
    expectedRevision: z.number().int().nonnegative(),
  }),
  /**
   * 会话重命名（dsh `sessionController.rename`，会写 `session/title` 事件并钉住标题）。
   * 冷会话由宿主侧自动 resume；规范化后为空 → `SESSION_TITLE_INVALID`。
   */
  z.object({
    method: z.literal('sessions/rename'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    title: z.string().min(1),
  }),
  /**
   * 归档/取消归档（dsh `workspaceController.archiveSession/unarchiveSession`）。
   * 归档是 workspace 门域的全局集合；有运行中工作时默认拒绝（`SESSION_ACTIVE`），
   * 传 `stopActivity: true` 则先归档再请求停止。
   */
  z.object({
    method: z.literal('sessions/archive'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    stopActivity: z.boolean().optional(),
  }),
  z.object({
    method: z.literal('sessions/unarchive'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /**
   * 物理删除一条**无工作区归属**的会话日志。
   *
   * dsh 持久层没有删除接口；桥接层只对“cwd 缺失或目录已不存在”的会话开放，
   * 并通过 `sessionPersistence.stat` 定位日志，避免 renderer 直接触碰磁盘路径。
   */
  z.object({
    method: z.literal('sessions/delete'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /** 置顶/取消置顶（宿主权威的 `pinnedSessionIds`；归档会话不可置顶）。 */
  z.object({
    method: z.literal('sessions/pin'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    method: z.literal('sessions/unpin'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  /** 工作区全量快照（登记表 + 顺序 + 归档/置顶集合）。 */
  z.object({
    method: z.literal('workspaces/list'),
    requestId: z.string().min(1),
  }),
  /** 登记一个目录为工作区（幂等：已存在时返回 created=false 与既有记录）。 */
  z.object({
    method: z.literal('workspaces/create'),
    requestId: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    method: z.literal('workspaces/rename'),
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string().min(1),
  }),
  /** 删除工作区**登记**（不删目录、不删会话；其会话回到「未分组」）。 */
  z.object({
    method: z.literal('workspaces/delete'),
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
  z.object({
    method: z.literal('workspaces/insertBefore'),
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    beforeWorkspaceId: z.string().min(1).optional(),
  }),
  /**
   * 从提供商拉取可用模型（dsh `llm.discoverModels`）：
   * 编辑中的草稿（baseURL/api/apiKey）或已配置路由（provider）二选一。
   */
  z.object({
    method: z.literal('models/discover'),
    requestId: z.string().min(1),
    discovery: modelDiscoveryRequestSchema,
  }),
  /**
   * 插件与 bundle 清单（UI-10）：数据源是宿主 `pluginManager`（官方插件管理 UI 同源），
   * 缺省时回退官方 inventory 只读投影。
   */
  z.object({
    method: z.literal('plugins/list'),
    requestId: z.string().min(1),
  }),
  /**
   * 启用/禁用单个插件行（dsh `pluginManager.setPluginEnabled`）。
   *
   * 语义照上游：写入 profile 的 `cordis.patch.yml` 后 reconcile；HMR 在线即时生效，
   * 被更高层补丁（如应用内置 overlay）覆盖时如实返回 `overridden`。
   */
  z.object({
    method: z.literal('plugins/set-enabled'),
    requestId: z.string().min(1),
    entryId: z.string().min(1),
    enabled: z.boolean(),
  }),
])
export type ControlRequest = z.infer<typeof controlRequestSchema>

export const controlErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
})
export type ControlError = z.infer<typeof controlErrorSchema>

export const controlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), requestId: z.string().min(1), result: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: z.string().min(1), error: controlErrorSchema }),
])
export type ControlResponse = z.infer<typeof controlResponseSchema>

export function controlError(code: string, message: string, retryable = false): ControlError {
  return { code, message, retryable }
}

export function controlResult(requestId: string, result: unknown): ControlResponse {
  return { ok: true, requestId, result }
}

export function controlFailure(requestId: string, error: ControlError): ControlResponse {
  return { ok: false, requestId, error }
}
