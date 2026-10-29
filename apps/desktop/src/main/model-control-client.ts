import {
  type ArchivedSessionsResult,
  archivedSessionsResultSchema,
  type ControlRequest,
  controlResponseSchema,
  type DiscoveredModel,
  discoveredModelSchema,
  type ModelCatalog,
  type ModelDiscoveryRequest,
  type ModelSelection,
  modelSelectionSchema,
  type PinnedSessionsResult,
  type PluginChangeResult,
  type PluginsList,
  pinnedSessionsResultSchema,
  pluginChangeResultSchema,
  pluginsListSchema,
  type SessionDeleteResult,
  type SessionList,
  type SessionRenameResult,
  type SessionReplay,
  type SettingsDescribe,
  type SettingsMutateRequest,
  type SettingsNamespace,
  sessionDeleteResultSchema,
  sessionListSchema,
  sessionRenameResultSchema,
  sessionReplaySchema,
  settingsDescribeSchema,
  settingsMutateResultSchema,
  type WorkspaceCreateResult,
  type WorkspaceList,
  type WorkspaceView,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceListSchema,
  workspaceOrderResultSchema,
  workspaceRenameResultSchema,
} from '@dexagent/bridges'
import { WebSocket } from 'ws'
import { z } from 'zod'

/** `sessions/prompt` 的回执：dsh 侧生成的消息 id，用于把「已入队」与「已执行」对齐。 */
const sessionPromptAckSchema = z.object({ messageId: z.string().min(1) })

type ControlBody =
  | Omit<Extract<ControlRequest, { method: 'models/list' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'models/select' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'models/discover' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'credentials/set' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'credentials/unset' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/list' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/replay' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/cancel' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/resume' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/prompt' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/rename' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/archive' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/unarchive' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/delete' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/pin' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'sessions/unpin' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'workspaces/list' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'workspaces/create' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'workspaces/rename' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'workspaces/delete' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'workspaces/insertBefore' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'settings/describe' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'settings/mutate' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'plugins/list' }>, 'requestId'>
  | Omit<Extract<ControlRequest, { method: 'plugins/set-enabled' }>, 'requestId'>

export class ModelControlError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'ModelControlError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * 宿主尚未监听时的重试退避。
 *
 * dsh 冷启动（profile 加载 / 链接自愈）可达 10s+，而 renderer 一挂载就会要会话列表，
 * 此时 dsh 的 webServer 还没 bind ——若直接失败，用户看到的是
 * `connect ECONNREFUSED 127.0.0.1:4320`，把「正在启动」误报成「坏了」。
 */
export const CONTROL_RETRY_DELAYS_MS = [200, 400, 800, 1600, 2400] as const

/**
 * 默认总超时：始终从发起时计时，重试共用这一份预算，避免无限等待。
 *
 * 45s 的依据是实测复测：
 * dsh 冷启动到 webServer 首次可连要 **23.2s**，之后 `/dex-control` 才注册路由。当年记的
 * 「TCP ~4.1s / 控制路由 ~9.1s」已失效——20s 预算在 17.6s 就命中守卫并抛出原始
 * `connect ECONNREFUSED 127.0.0.1:4320`，`dex.models.list` 因此每次开屏必报错。
 *
 * 抬预算只解决「等得不够久」；真正省时间的是 `hostFailure`：宿主一旦进入终态就立刻失败，
 * 不必把整份预算空转完。
 */
export const CONTROL_REQUEST_TIMEOUT_MS = 45_000

/**
 * 该错误是否属于「宿主还没开始监听」这类**可重试**的连接失败。
 * 只认连接层错误——业务错误（schema 不符、`ok:false`）绝不重试。
 */
export function isRetryableConnectError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') return true
  const message = error.message
  return (
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('socket hang up')
  )
}

export interface ModelControlClient {
  list(sessionId?: string): Promise<ModelCatalog>
  select(sessionId: string, selection: ModelSelection): Promise<ModelSelection>
  setCredential(
    provider: string,
    apiKey: string,
  ): Promise<{ provider: string; configured: boolean }>
  unsetCredential(provider: string): Promise<{ provider: string; configured: boolean }>
  listSessions(cursor?: string): Promise<SessionList>
  replaySession(sessionId: string): Promise<SessionReplay>
  /** 取消该会话的活跃轮次（dsh `agent.cancel({kind:'user'})`）。 */
  cancelSession(sessionId: string): Promise<void>
  /**
   * 把磁盘上的历史会话恢复成活体（dsh `agents.resume`，D33）。
   *
   * @returns 恢复后实际生效的模型；`null` 表示没指定、由 dsh 默认模型决定。
   */
  resumeSession(input: {
    readonly sessionId: string
    readonly selection?: ModelSelection
  }): Promise<ModelSelection | null>
  /** 往**已恢复**的会话投递一条用户消息。 */
  promptSession(input: {
    readonly sessionId: string
    readonly content: string
  }): Promise<{ readonly messageId: string }>
  /** 会话重命名（宿主 `sessionController.rename`；会写 `session/title` 并钉住标题）。 */
  renameSession(input: {
    readonly sessionId: string
    readonly title: string
  }): Promise<SessionRenameResult>
  /** 归档会话；有运行中工作时宿主会拒绝（`SESSION_ACTIVE`），可带 `stopActivity`。 */
  archiveSession(input: {
    readonly sessionId: string
    readonly stopActivity?: boolean
  }): Promise<ArchivedSessionsResult>
  unarchiveSession(sessionId: string): Promise<ArchivedSessionsResult>
  deleteSession(sessionId: string): Promise<SessionDeleteResult>
  pinSession(sessionId: string): Promise<PinnedSessionsResult>
  unpinSession(sessionId: string): Promise<PinnedSessionsResult>
  listWorkspaces(): Promise<WorkspaceList>
  createWorkspace(path: string): Promise<WorkspaceCreateResult>
  renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView>
  /** 删除工作区**登记**（不删目录与会话；其会话回到「未分组」）。 */
  deleteWorkspace(workspaceId: string): Promise<void>
  insertWorkspaceBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<readonly string[]>
  /** 从提供商拉取可用模型（编辑草稿或已配置路由二选一）。 */
  discoverModels(input: ModelDiscoveryRequest): Promise<readonly DiscoveredModel[]>
  settingsDescribe(): Promise<SettingsDescribe>
  settingsMutate(input: SettingsMutateRequest): Promise<SettingsNamespace>
  /** 插件与 bundle 清单（UI-10；宿主 `pluginManager` 同源）。 */
  listPlugins(): Promise<PluginsList>
  /** 启用/禁用单个插件行；业务失败以 `ModelControlError`（结构化码）抛出。 */
  setPluginEnabled(input: {
    readonly entryId: string
    readonly enabled: boolean
  }): Promise<PluginChangeResult>
}

export interface ModelControlClientOptions {
  /**
   * 宿主已进入**终态**时返回一句人话原因（`missing` / `error` / `stopped`），否则返回 null。
   *
   * 重试只为等「还没开始监听」的冷启动；宿主进程已经死掉或压根没找到 CLI 时再等毫无意义，
   * 应当立刻失败并把人话原因交给 UI，而不是把 45s 预算空转完再抛 `ECONNREFUSED`。
   */
  readonly hostFailure?: (() => string | null) | undefined
}

export function createModelControlClient(
  url: string,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  options: ModelControlClientOptions = {},
): ModelControlClient {
  let nextId = 0

  const request = <T>(body: ControlBody): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const requestId = `dex-control-${String(++nextId)}`
      const secret = body.method === 'credentials/set' ? body.apiKey : undefined
      const redact = (message: string): string =>
        secret === undefined || secret.length === 0
          ? message
          : message.replaceAll(secret, '[redacted]')

      const deadline = Date.now() + timeoutMs
      let attempt = 0
      let settled = false
      let retryTimer: NodeJS.Timeout | null = null

      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        if (retryTimer !== null) clearTimeout(retryTimer)
        action()
      }

      const onError = (error: Error): void => {
        if (settled) return
        if (!isRetryableConnectError(error)) {
          settle(() => reject(new Error(redact(error.message))))
          return
        }
        const hostFailure = options.hostFailure?.() ?? null
        const index = Math.min(attempt, CONTROL_RETRY_DELAYS_MS.length - 1)
        const delay = CONTROL_RETRY_DELAYS_MS[index] ?? 2400
        // 下一次尝试必须落在超时预算内，否则不再等——避免实际耗时突破 timeoutMs。
        if (hostFailure !== null || Date.now() + delay >= deadline) {
          settle(() => reject(new Error(redact(hostFailure ?? error.message))))
          return
        }
        attempt += 1
        retryTimer = setTimeout(open, delay)
      }

      const open = (): void => {
        if (settled) return
        const hostFailure = options.hostFailure?.() ?? null
        if (hostFailure !== null) {
          settle(() => reject(new Error(redact(hostFailure))))
          return
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          settle(() => reject(new Error('模型控制请求超时')))
          return
        }
        const socket = new WebSocket(url)
        const timer = setTimeout(() => {
          socket.close()
          settle(() => reject(new Error('模型控制请求超时')))
        }, remaining)
        socket.on('open', () => {
          socket.send(JSON.stringify({ ...body, requestId }))
        })
        socket.on('message', (raw) => {
          let parsedJson: unknown
          try {
            parsedJson = JSON.parse(String(raw))
          } catch {
            return
          }
          const parsed = controlResponseSchema.safeParse(parsedJson)
          if (!parsed.success || parsed.data.requestId !== requestId) return
          clearTimeout(timer)
          socket.close()
          if (!parsed.data.ok) {
            // 先取值再进闭包：`settle` 的回调里 TS 无法保留 discriminated union 的收窄
            const { code, retryable } = parsed.data.error
            const message = redact(parsed.data.error.message)
            settle(() => reject(new ModelControlError(code, message, retryable)))
            return
          }
          const result = parsed.data.result as T
          settle(() => resolve(result))
        })
        socket.on('error', (error) => {
          clearTimeout(timer)
          onError(error)
        })
      }

      open()
    })

  return {
    list: (sessionId) =>
      request<ModelCatalog>({
        method: 'models/list',
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    select: (sessionId, selection) =>
      request<ModelSelection>({ method: 'models/select', sessionId, selection }),
    setCredential: (provider, apiKey) => request({ method: 'credentials/set', provider, apiKey }),
    unsetCredential: (provider) => request({ method: 'credentials/unset', provider }),
    listSessions: async (cursor) =>
      sessionListSchema.parse(
        await request<unknown>({
          method: 'sessions/list',
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    replaySession: async (sessionId) =>
      sessionReplaySchema.parse(await request<unknown>({ method: 'sessions/replay', sessionId })),
    cancelSession: async (sessionId) => {
      await request<unknown>({ method: 'sessions/cancel', sessionId })
    },
    resumeSession: async (input) =>
      modelSelectionSchema.nullable().parse(
        await request<unknown>({
          method: 'sessions/resume',
          sessionId: input.sessionId,
          ...(input.selection === undefined ? {} : { selection: input.selection }),
        }),
      ),
    promptSession: async (input) =>
      sessionPromptAckSchema.parse(
        await request<unknown>({
          method: 'sessions/prompt',
          sessionId: input.sessionId,
          content: input.content,
        }),
      ),
    renameSession: async (input) =>
      sessionRenameResultSchema.parse(
        await request<unknown>({
          method: 'sessions/rename',
          sessionId: input.sessionId,
          title: input.title,
        }),
      ),
    archiveSession: async (input) =>
      archivedSessionsResultSchema.parse(
        await request<unknown>({
          method: 'sessions/archive',
          sessionId: input.sessionId,
          ...(input.stopActivity === undefined ? {} : { stopActivity: input.stopActivity }),
        }),
      ),
    unarchiveSession: async (sessionId) =>
      archivedSessionsResultSchema.parse(
        await request<unknown>({ method: 'sessions/unarchive', sessionId }),
      ),
    deleteSession: async (sessionId) =>
      sessionDeleteResultSchema.parse(
        await request<unknown>({ method: 'sessions/delete', sessionId }),
      ),
    pinSession: async (sessionId) =>
      pinnedSessionsResultSchema.parse(
        await request<unknown>({ method: 'sessions/pin', sessionId }),
      ),
    unpinSession: async (sessionId) =>
      pinnedSessionsResultSchema.parse(
        await request<unknown>({ method: 'sessions/unpin', sessionId }),
      ),
    listWorkspaces: async () =>
      workspaceListSchema.parse(await request<unknown>({ method: 'workspaces/list' })),
    createWorkspace: async (path) =>
      workspaceCreateResultSchema.parse(
        await request<unknown>({ method: 'workspaces/create', path }),
      ),
    renameWorkspace: async (workspaceId, title) =>
      workspaceRenameResultSchema.parse(
        await request<unknown>({ method: 'workspaces/rename', workspaceId, title }),
      ).workspace,
    deleteWorkspace: async (workspaceId) => {
      workspaceDeleteResultSchema.parse(
        await request<unknown>({ method: 'workspaces/delete', workspaceId }),
      )
    },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) =>
      workspaceOrderResultSchema.parse(
        await request<unknown>({
          method: 'workspaces/insertBefore',
          workspaceId,
          ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
        }),
      ).workspaceIds,
    discoverModels: async (input) => {
      const result = await request<unknown>({ method: 'models/discover', discovery: input })
      return z.array(discoveredModelSchema).parse(result)
    },
    settingsDescribe: async () =>
      settingsDescribeSchema.parse(await request<unknown>({ method: 'settings/describe' })),
    settingsMutate: async (input) =>
      settingsMutateResultSchema.parse(
        await request<unknown>({
          method: 'settings/mutate',
          namespace: input.namespace,
          operations: input.operations,
          expectedRevision: input.expectedRevision,
        }),
      ),
    listPlugins: async () =>
      pluginsListSchema.parse(await request<unknown>({ method: 'plugins/list' })),
    setPluginEnabled: async (input) =>
      pluginChangeResultSchema.parse(
        await request<unknown>({
          method: 'plugins/set-enabled',
          entryId: input.entryId,
          enabled: input.enabled,
        }),
      ),
  }
}
