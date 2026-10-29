import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readdir, rm, rmdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  type SessionList,
  type SessionReplay,
  sessionEventSchema,
  sortSessionSummaries,
  summarizeSessionEvents,
} from '@dexagent/shared'
import { WebSocketServer } from 'ws'
import {
  type AgentHandleLike,
  type AgentLike,
  type CreateUserMessageLike,
  createAgentSession,
} from '../plugins/agent-session'
import {
  archivedSessionsResultSchema,
  type ConfigurableProvider,
  type ControlResponse,
  controlError,
  controlFailure,
  controlRequestSchema,
  controlResult,
  type DiscoveredModel,
  discoveredModelSchema,
  type ModelCatalog,
  type ModelSelection,
  modelCatalogSchema,
  modelSelectionSchema,
  type PluginBundleInfo,
  type PluginChangeResult,
  type PluginInfo,
  type PluginsList,
  pinnedSessionsResultSchema,
  pluginChangeResultSchema,
  pluginsListSchema,
  type SettingsPathOperation,
  sessionDeleteResultSchema,
  sessionRenameResultSchema,
  settingsDescribeSchema,
  settingsMutateResultSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceListSchema,
  workspaceOrderResultSchema,
  workspaceRenameResultSchema,
} from '../plugins/model-control'
import { applySessionEvent, createInitialProjectionState } from '../plugins/trace-fold'
import type { DexWebServer } from './entry'
import { ringsProviderProfile } from './rings-profile'

export const DEX_MODEL_CONTROL_HOST_NAME = 'dex-model-control'
export const DEX_MODEL_CONTROL_ROUTE = '/dex-control'
const WS_OPEN = 1

export function isSessionArtifactName(name: string): boolean {
  return /^session(?:\.[vV]\d+)?\.jsonl(?:\.zstd)?$/.test(name) || name === 'session.lock'
}

export async function removeSessionArtifactFiles(logPath: string): Promise<boolean> {
  const directory = dirname(logPath)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return false
  }
  let removed = false
  for (const entry of entries) {
    if (!isSessionArtifactName(entry)) continue
    await rm(join(directory, entry), { force: true })
    removed = true
  }
  if (removed) await rmdir(directory).catch(() => undefined)
  return removed
}

type UnknownRecord = Record<string, unknown>

interface ModelRuntime {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  /** 可配置 provider 目录（含未生效路由）；旧版 dsh 可能没有。 */
  listConfigurableProviders?(): readonly ConfigurableProvider[]
  /** 从提供商拉取模型（编辑草稿或已配置路由）。 */
  discoverModels?(
    settingsNs: string,
    request: {
      readonly provider?: string
      readonly baseURL?: string
      readonly api?: string
      readonly apiKey?: string
    },
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredModel[]>
}

/** `ctx.workspaceController` 的投影（控制面写操作；读取走 registry）。 */
interface WorkspaceControllerRuntime {
  create(request: {
    readonly path: string
  }): Promise<{ readonly workspace: WorkspaceViewLike; readonly created: boolean }>
  rename(request: {
    readonly workspaceId: string
    readonly title: string
  }): Promise<{ readonly workspace: WorkspaceViewLike }>
  delete(request: { readonly workspaceId: string }): Promise<{ readonly deleted: true }>
  insertBefore(request: {
    readonly workspaceId: string
    readonly beforeWorkspaceId?: string
  }): Promise<{ readonly workspaceIds: readonly string[] }>
  archiveSession(request: {
    readonly sessionId: string
    readonly stopActivity?: boolean
  }): Promise<{ readonly archivedSessionIds: readonly string[] }>
  unarchiveSession(request: {
    readonly sessionId: string
  }): Promise<{ readonly archivedSessionIds: readonly string[] }>
  pinSession(request: {
    readonly sessionId: string
  }): Promise<{ readonly pinnedSessionIds: readonly string[] }>
  unpinSession(request: {
    readonly sessionId: string
  }): Promise<{ readonly pinnedSessionIds: readonly string[] }>
}

/**
 * `ctx.sessionTitle` 的投影（会话重命名）。
 *
 * 为什么不走 `sessionController.rename`：session-controller 的 inject 链拖进
 * web 传输（fileUploads → connection），dex profile（base + sdk-app）挂不动；
 * `sessionTitle.rename` 是同一个权威实现（写 `session/title`、钉住用户标题），
 * 只要求会话是活体——桥接层已有 `ensureLive`，冷会话先恢复再改名。
 */
interface SessionTitleRuntime {
  rename(session: unknown, title: string): { readonly title: string; readonly eventSeq: number }
  /** 活体会话的当前标题投影（last-wins）。 */
  get(session: unknown): { readonly title: string } | undefined
}

/** `ctx.sessions`（SessionStore）的最小读取面。 */
interface SessionsStoreRuntime {
  get(id: string): unknown | undefined
}

/** workspace 实体（`@deepseek-ai/dsh-workspace` 的 WorkspaceEntity 投影）。 */
interface WorkspaceEntityLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** workspace controller 的 wire 视图（`WorkspaceView`）。 */
interface WorkspaceViewLike {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** `ctx.workspaceRegistry`：登记表 + 全局顺序 + 归档/置顶集合。 */
interface WorkspaceRegistryRuntime {
  list(): readonly WorkspaceEntityLike[]
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
}

interface WorkspaceViewOutput {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt?: number
  readonly updatedAt?: number
}

function workspaceViewOf(workspace: WorkspaceEntityLike | WorkspaceViewLike): WorkspaceViewOutput {
  const id = 'id' in workspace ? workspace.id : workspace.workspaceId
  const toNumber = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const view: {
    workspaceId: string
    path: string
    title: string
    sessionIds: readonly string[]
    createdAt?: number
    updatedAt?: number
  } = {
    workspaceId: id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
  }
  const createdAt = toNumber(workspace.createdAt)
  if (createdAt !== undefined) view.createdAt = createdAt
  const updatedAt = toNumber(workspace.updatedAt)
  if (updatedAt !== undefined) view.updatedAt = updatedAt
  return view
}

interface CredentialRuntime {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

interface SettingsRuntime {
  readonly writable: boolean
  readonly documentPath?: string
  describe(options?: { readonly redactSecrets?: boolean }): readonly unknown[]
  mutate(
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision?: number,
  ): Promise<void>
}

/** `ctx.pluginManager` 的最小投影（UI-10 插件管理的宿主侧数据源）。 */
interface PluginManagerRuntime {
  listPlugins(): Promise<readonly unknown[]>
  listBundles(): Promise<readonly unknown[]>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<unknown>
}

/** 控制桥额外用到的 Agent 能力（cancel 归 `sessions/cancel` 用）。 */
type ControlAgentLike = AgentLike & {
  readonly cancel?: (
    cause: { readonly kind: string },
    options?: { readonly keepInbox?: boolean },
  ) => void
}

/** `ctx.agents` 的投影：`get` 用于 `sessions/cancel`，`resume` 交给 agent-session。 */
interface AgentRegistryLike {
  get(id: string): ControlAgentLike | undefined
  resume?(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }
  }): Promise<AgentHandleLike>
}

/** `@deepseek-ai/dsh-llm` 里我们唯一用到的导出。 */
interface LlmModuleLike {
  createUserMessage?: CreateUserMessageLike
}

interface SessionPersistenceLike {
  list(): Promise<readonly { header: { id: string; createdAt?: number } }[]>
  stat(id: string): Promise<
    | {
        readonly header: { readonly id: string; readonly cwd?: string }
        readonly location?: { readonly kind: string; readonly path: string }
      }
    | undefined
  >
  open(
    id: string,
    access: 'read',
  ): Promise<{
    read(): Promise<{ events: readonly unknown[] }>
    close(): Promise<void>
  }>
}

export interface DexModelControlContext {
  readonly webServer: DexWebServer
  readonly get?: (name: string) => unknown
  readonly settings?: SettingsRuntime
  /**
   * cordis 清理钩子。桥接插件卸载（宿主热重启 / fiber 释放）时用它把本插件 resume
   * 出来的 `AgentHandle` 一并 dispose —— handle 是**拥有权能力**，不释放就等于让
   * 宿主里留着一个没人负责的活体。缺省时如实降级为「不主动释放」。
   */
  readonly effect?: (execute: () => () => unknown, label?: string) => unknown
  /** cordis 依赖注入（rings 播种要等 settings 服务就绪）。缺省时降级为立即尝试。 */
  readonly inject?: (
    names: readonly string[],
    callback: (ctx: DexModelControlContext) => unknown,
  ) => unknown
}

export interface DexModelControlHostOptions {
  readonly routePath?: string
  readonly log?: (line: string) => void
}

interface SelectionRef {
  current: ModelSelection
  assembled?: ModelSelection
}

/** profile 兜底路径的「尾巴」（`<profile 的 node_modules>` 之后的部分）。桥接插件是自包含 ESM，由 profile patch 以 `file://` 直载，不在 dsh 的模块解析链上，所以要显式拼。 */
const DSH_AGENT_MODULE_TAIL = ['@deepseek-ai', 'dsh-agent', 'lib', 'index.js'] as const
const DSH_LLM_MODULE_TAIL = ['@deepseek-ai', 'dsh-llm', 'lib', 'index.js'] as const
const DSH_PLUGIN_INVENTORY_MODULE_TAIL = [
  '@deepseek-ai',
  'dsh-host-plugin-inventory',
  'lib',
  'index.js',
] as const

/** dexAgent 在 dsh home 里使用的 profile 名（主进程经 env 显式传入，缺省 `dex`）。 */
function dexProfileName(): string {
  return process.env.DEX_DSH_PROFILE?.trim() || 'dex'
}

/** 动态 import 的间接层：本模块被打包成 ESM，直接写 `import()` 会被打包器静态解析。 */
const importModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>

/**
 * 列出模块在 dsh home 下的候选路径，顺序即优先级。
 *
 * **为什么不能是一个固定路径**（2026-10-06 修复）：dsh 0.2 起 profile 布局由
 * 「`profiles/node_modules` 单 profile 共享池」改为「`profiles/<name>/node_modules`
 * 各自装依赖」。兜底路径原先只认前者，于是在 `~/.dex-dsh`（本机默认 home）这种新
 * 布局下必然落空——包其实好好地躺在 `profiles/dex/node_modules/@deepseek-ai/dsh-llm`
 * 里，症状却是发消息时报「dsh 消息构造能力不可用」。这里对齐主进程 `resolveDshBin`
 * 的搜索顺序：指定 profile → 其他 profile（用户换过 profile 名时的兜底）→ 历史共享池。
 */
export function profileModuleCandidates(dshHome: string, tail: readonly string[]): string[] {
  const profile = dexProfileName()
  const profilesDir = join(dshHome, 'profiles')
  const candidates = [join(profilesDir, profile, 'node_modules', ...tail)]
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === profile) continue
      candidates.push(join(profilesDir, entry.name, 'node_modules', ...tail))
    }
  } catch {
    // profiles 目录缺失或不可读：保留显式 profile 与共享池两条候选即可。
  }
  candidates.push(join(profilesDir, 'node_modules', ...tail))
  return candidates
}

/**
 * 载入一个 dsh 运行时模块。
 *
 * 先按包名解析（宿主进程的解析链），失败再用 `DSH_HOME` 下的候选路径兜底
 * ——桥接插件自身所在目录不在 dsh 的模块解析链上（M1-04 起沿用同一套兜底）。
 * @returns 模块命名空间；所有路径都不可用时返回 `null`（由调用方给出人话错误）。
 */
async function loadDshModule<T>(
  specifier: string,
  moduleTail: readonly string[],
): Promise<T | null> {
  try {
    return (await importModule(specifier)) as T
  } catch {
    // 包名解析失败是常态（插件不在 dsh 解析链上），继续走路径兜底。
  }
  const dshHome = process.env.DSH_HOME ?? process.env.DEX_DSH_HOME
  if (dshHome === undefined) return null
  for (const candidate of profileModuleCandidates(dshHome, moduleTail)) {
    try {
      return (await importModule(pathToFileURL(candidate).href)) as T
    } catch {
      // 该候选不存在或加载失败：试下一个。
    }
  }
  return null
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function credentialRef(provider: string): string {
  if (provider === 'deepseek-official') return 'DEEPSEEK_API_KEY'
  if (provider === 'rings') return 'RINGS_API_KEY'
  if (provider === 'opencode-go') return 'OPENCODE_API_KEY'
  return `${provider.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
}

function asSelection(value: unknown): ModelSelection | null {
  const parsed = modelSelectionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** dsh 的展示文案可能是 `{en: string, [locale]: string}`；取英文回退，缺省不显示。 */
export function localizedText(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  const record = asRecord(value)
  const en = record?.en
  return typeof en === 'string' && en !== '' ? en : undefined
}

/**
 * 行 id 与设置命名空间的对应：settings 的 `ns` 是组合行 id（`entry.options.id`），
 * 而 Loader 条目 id 带 `include:` 前缀（如 `include:llm-pi-ai`）；嵌套时取最后一段匹配。
 */
export function pluginSettingsNamespace(entryId: string, namespaces: ReadonlySet<string>): boolean {
  if (namespaces.has(entryId)) return true
  const tail = entryId.split(':').at(-1)
  return tail !== undefined && namespaces.has(tail)
}

export function pluginRowOf(raw: unknown, namespaces: ReadonlySet<string>): PluginInfo | null {
  const value = asRecord(raw)
  if (value === null) return null
  const entryId = value.entryId
  const moduleName = value.moduleName
  if (typeof entryId !== 'string' || typeof moduleName !== 'string') return null
  const meta = asRecord(value.meta)
  const title = localizedText(meta?.title)
  const description = localizedText(meta?.description)
  return {
    entryId,
    moduleName,
    enabled: value.enabled === true,
    fiberPhase:
      value.fiberPhase === null || value.fiberPhase === undefined
        ? null
        : // 非法相位交给 schema 兜底（fail-loud，而不是把坏数据当 active）。
          (value.fiberPhase as PluginInfo['fiberPhase']),
    ...(typeof value.patchId === 'string' ? { patchId: value.patchId } : {}),
    ...(typeof value.readOnlyReason === 'string'
      ? { readOnlyReason: value.readOnlyReason as PluginInfo['readOnlyReason'] }
      : {}),
    hasSettings: pluginSettingsNamespace(entryId, namespaces),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

export function bundleRowOf(raw: unknown): PluginBundleInfo | null {
  const value = asRecord(raw)
  if (value === null || typeof value.name !== 'string') return null
  const meta = asRecord(value.meta)
  const description =
    localizedText(meta?.description) ??
    (typeof value.description === 'string' && value.description !== ''
      ? value.description
      : undefined)
  const error = asRecord(value.error)
  return {
    name: value.name,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(description === undefined ? {} : { description }),
    enabled: value.enabled === true,
    optional: value.optional === true,
    removable: value.removable === true,
    ...(typeof value.readOnlyReason === 'string'
      ? { readOnlyReason: value.readOnlyReason as PluginBundleInfo['readOnlyReason'] }
      : {}),
    ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
  }
}

/** `setPluginEnabled` 的业务失败码 → 面向用户的结构化错误（硬规则 8）。 */
const PLUGIN_FAILURE_TEXT: Record<
  string,
  { readonly code: string; readonly message: string; readonly retryable: boolean }
> = {
  'management-required': {
    code: 'PLUGIN_MANAGEMENT_REQUIRED',
    message: '该插件属于插件管理链路，不能在应用内启停',
    retryable: false,
  },
  unaddressable: {
    code: 'PLUGIN_UNADDRESSABLE',
    message: '该插件由嵌套组合提供，无法通过 profile 补丁启停',
    retryable: false,
  },
  'unknown-plugin': {
    code: 'PLUGIN_UNKNOWN',
    message: '找不到该插件（宿主可能已重载，请刷新列表）',
    retryable: true,
  },
  'incompatible-version': {
    code: 'PLUGIN_INCOMPATIBLE',
    message: '该插件与当前 dsh 版本不兼容',
    retryable: false,
  },
  'operation-error': {
    code: 'PLUGIN_OPERATION_FAILED',
    message: '插件操作失败（宿主日志里有诊断）',
    retryable: true,
  },
}

export function pluginFailureOf(errorCode: string | undefined): {
  code: string
  message: string
  retryable: boolean
} {
  return (
    (errorCode === undefined ? undefined : PLUGIN_FAILURE_TEXT[errorCode]) ?? {
      code: 'PLUGIN_OPERATION_FAILED',
      message: '插件操作失败',
      retryable: true,
    }
  )
}

async function installSelection(
  agent: AgentLike,
  selection: ModelSelection,
  ref: SelectionRef,
): Promise<void> {
  const agentContext = agent.ctx
  if (agentContext === undefined) throw new Error('agent context is unavailable')
  if (typeof (agentContext as { on?: unknown }).on !== 'function') {
    throw new Error('agent model-selection context is unavailable')
  }
  ref.current = selection
  const module = await loadDshModule<{
    installModelSelection?: (ctx: unknown, selection: SelectionRef) => () => void
  }>('@deepseek-ai/dsh-agent', DSH_AGENT_MODULE_TAIL)
  if (module?.installModelSelection === undefined) {
    throw new Error('dsh model-selection capability is unavailable')
  }
  if (
    (agent as AgentLike & { __dexModelSelection?: SelectionRef }).__dexModelSelection === undefined
  ) {
    module.installModelSelection(agentContext, ref)
    ;(agent as AgentLike & { __dexModelSelection?: SelectionRef }).__dexModelSelection = ref
  }
}

export function createDexModelControlHost(options: DexModelControlHostOptions = {}) {
  const routePath = options.routePath ?? DEX_MODEL_CONTROL_ROUTE
  const log =
    options.log ??
    ((message: string): void => {
      process.stderr.write(`[dex-model-control] ${message}\n`)
    })

  return {
    name: DEX_MODEL_CONTROL_HOST_NAME,
    inject: ['webServer', 'settings'] as const,
    apply(ctx: DexModelControlContext): void {
      const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
      const selections = new Map<string, SelectionRef>()
      let userMessageFactory: CreateUserMessageLike | null = null
      const runtime = (): {
        llm: ModelRuntime
        credentials: CredentialRuntime
        agents: AgentRegistryLike
        settings: SettingsRuntime
      } => {
        const get = ctx.get
        const llm = get?.('llm') as ModelRuntime | undefined
        const credentials = get?.('credentials') as CredentialRuntime | undefined
        const agents = get?.('agents') as AgentRegistryLike | undefined
        const settings = ctx.settings ?? (get?.('settings') as SettingsRuntime | undefined)
        if (
          llm === undefined ||
          credentials === undefined ||
          agents === undefined ||
          settings === undefined
        ) {
          throw new Error('dsh model control services are unavailable')
        }
        return { llm, credentials, agents, settings }
      }
      const persistence = (): SessionPersistenceLike => {
        const value = ctx.get?.('sessionPersistence') as SessionPersistenceLike | undefined
        if (value === undefined) throw new Error('dsh session persistence is unavailable')
        return value
      }

      /** UI-10 插件管理：数据源与官方插件管理 UI 同源（宿主 `pluginManager` 服务）。 */
      const pluginManager = (): PluginManagerRuntime | null =>
        (ctx.get?.('pluginManager') as PluginManagerRuntime | undefined) ?? null

      const hmrAvailable = (): boolean => ctx.get?.('hmr') !== undefined

      const settingsNamespaces = (): ReadonlySet<string> => {
        const settings = ctx.settings ?? (ctx.get?.('settings') as SettingsRuntime | undefined)
        const names = new Set<string>()
        for (const entry of settings?.describe({ redactSecrets: true }) ?? []) {
          const ns = asRecord(entry)?.ns
          if (typeof ns === 'string' && ns !== '') names.add(ns)
        }
        return names
      }

      const pluginsListPayload = async (): Promise<PluginsList> => {
        const namespaces = settingsNamespaces()
        const manager = pluginManager()
        if (manager !== null) {
          const [pluginsRaw, bundlesRaw] = await Promise.all([
            manager.listPlugins(),
            manager.listBundles(),
          ])
          return pluginsListSchema.parse({
            managementAvailable: true,
            hmrAvailable: hmrAvailable(),
            plugins: pluginsRaw.flatMap((row) => {
              const plugin = pluginRowOf(row, namespaces)
              return plugin === null ? [] : [plugin]
            }),
            bundles: bundlesRaw.flatMap((row) => {
              const bundle = bundleRowOf(row)
              return bundle === null ? [] : [bundle]
            }),
          })
        }
        // 回退（非 profile 宿主 / 服务缺失）：官方 inventory 只读投影，无启停。
        const inventory = await loadDshModule<{
          readPluginInventory?: (scope: unknown) => Promise<{ entries: readonly unknown[] }>
        }>('@deepseek-ai/dsh-host-plugin-inventory', DSH_PLUGIN_INVENTORY_MODULE_TAIL)
        const snapshot = await inventory?.readPluginInventory?.({
          loader: ctx.get?.('loader'),
          get: (name: string) => ctx.get?.(name),
        })
        return pluginsListSchema.parse({
          managementAvailable: false,
          hmrAvailable: hmrAvailable(),
          plugins: (snapshot?.entries ?? []).flatMap((row) => {
            const plugin = pluginRowOf(row, namespaces)
            return plugin === null ? [] : [plugin]
          }),
          bundles: [],
        })
      }

      const currentSelection = (sessionId?: string): ModelSelection | null => {
        if (sessionId === undefined) return null
        const selected = selections.get(sessionId)?.current
        if (selected !== undefined) return selected
        return asSelection(runtime().agents.get(sessionId)?.options)
      }

      /**
       * 会话恢复 + 消息投递（D33）：逻辑全在 `plugins/agent-session.ts`，
       * 这里只做装配——把 dsh 的模块解析、模型选择安装、卸载钩子接进去。
       */
      const agentSession = createAgentSession({
        getAgents: () => runtime().agents,
        selectionOf: (sessionId) => selections.get(sessionId)?.current,
        installSelection: async (sessionId, agent, selection) => {
          const ref = selections.get(sessionId)
          if (ref === undefined) return
          await installSelection(agent, selection, ref)
        },
        loadUserMessageFactory: async () => {
          if (userMessageFactory !== null) return userMessageFactory
          const module = await loadDshModule<LlmModuleLike>(
            '@deepseek-ai/dsh-llm',
            DSH_LLM_MODULE_TAIL,
          )
          userMessageFactory = module?.createUserMessage ?? null
          return userMessageFactory
        },
      })

      /**
       * 卸载钩子：宿主热重载 / 进程退出 / 插件被摘掉时，不能把 resume 出来的 agent
       * 留在宿主的 agent 表里（handle 是拥有权能力，持有者负责释放）。
       */
      ctx.effect?.(() => agentSession.disposeAll, 'dex-model-control:agent-handles')

      const workspaceController = (): WorkspaceControllerRuntime => {
        const value = ctx.get?.('workspaceController') as WorkspaceControllerRuntime | undefined
        if (value === undefined) throw new Error('dsh workspace controller is unavailable')
        return value
      }
      const workspaceRegistry = (): WorkspaceRegistryRuntime => {
        const value = ctx.get?.('workspaceRegistry') as WorkspaceRegistryRuntime | undefined
        if (value === undefined) throw new Error('dsh workspace registry is unavailable')
        return value
      }
      const sessionTitle = (): SessionTitleRuntime => {
        const value = ctx.get?.('sessionTitle') as SessionTitleRuntime | undefined
        if (value === undefined) throw new Error('dsh 标题服务未挂载，无法重命名会话')
        return value
      }
      const sessionsStore = (): SessionsStoreRuntime | undefined =>
        ctx.get?.('sessions') as SessionsStoreRuntime | undefined
      /** 归档会话的门禁（dsh 由 ArchivedSessionGate 挂在 agent/pre-step；这里在投递边界兜底）。 */
      const assertNotArchived = (sessionId: string): void => {
        let archived: readonly string[] = []
        try {
          archived = workspaceRegistry().archivedSessionIds
        } catch {
          return
        }
        if (archived.includes(sessionId)) {
          throw Object.assign(new Error('该会话已归档，请先取消归档再继续对话'), {
            code: 'session/archived',
          })
        }
      }

      const deleteOrphanSessionLog = async (
        sessionId: string,
      ): Promise<{ readonly deleted: true; readonly removedLog: boolean }> => {
        if (sessionsStore()?.get(sessionId) !== undefined) {
          throw Object.assign(new Error('该会话仍在宿主中打开，不能直接删除'), {
            code: 'workspace/session-active',
          })
        }
        const snapshot = await persistence().stat(sessionId)
        if (snapshot === undefined) {
          throw Object.assign(new Error('找不到该会话日志'), { code: 'session/not-found' })
        }
        const cwd = snapshot.header.cwd
        if (cwd !== undefined && existsSync(cwd)) {
          throw Object.assign(new Error('该会话仍绑定有效工作区，只能归档'), {
            code: 'dex/session-workspace-bound',
          })
        }
        try {
          if (workspaceRegistry().archivedSessionIds.includes(sessionId)) {
            await workspaceController().unarchiveSession({ sessionId })
          }
          if (workspaceRegistry().pinnedSessionIds.includes(sessionId)) {
            await workspaceController().unpinSession({ sessionId })
          }
        } catch {
          // Host sets are best-effort cleanup for a log that is about to disappear.
        }
        if (snapshot.location === undefined || snapshot.location.kind !== 'jsonl') {
          return { deleted: true, removedLog: false }
        }
        return {
          deleted: true,
          removedLog: await removeSessionArtifactFiles(snapshot.location.path),
        }
      }

      /**
       * rings 播种（迁移，2026-10-07）：把 rings provider 写进 `llm-pi-ai`
       * 的 **user 设置层**，而不是再用 `--patch` overlay——overlay 的顶层键替换会
       * 整体覆盖 `config.providers`，既吞掉用户自定义 provider，又让一切设置写入
       * 被写保护拒绝。播种幂等：已有 `providers.rings`（用户改过/删过）就不再写。
       */
      /** @returns true = 已就绪（播种完成或用户已有配置）；false = llm-pi-ai 还没挂载。 */
      const seedRings = async (): Promise<boolean> => {
        if (process.env.DEX_ENABLE_RINGS === '0') return true
        const { settings } = runtime()
        const namespaces = settings.describe({ redactSecrets: true })
        const ns = namespaces.find((entry) => asRecord(entry)?.ns === 'llm-pi-ai')
        const nsRecord = asRecord(ns)
        if (nsRecord === null) return false
        const providers = asRecord(asRecord(nsRecord.value)?.providers)
        if (providers !== null && providers.rings !== undefined) return true
        const revision = typeof nsRecord.revision === 'number' ? nsRecord.revision : 0
        await settings.mutate(
          'llm-pi-ai',
          [{ op: 'set', path: ['providers', 'rings'], value: ringsProviderProfile() }],
          revision,
        )
        return true
      }
      let ringsSeeded = false
      const ensureRingsSeeded = async (): Promise<void> => {
        if (ringsSeeded) return
        try {
          ringsSeeded = await seedRings()
        } catch (error) {
          // llm-pi-ai 可能尚未挂载或 settings 未就绪：保留 pending，下次调用再试。
          log(`rings seed deferred: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (ctx.inject !== undefined) {
        ctx.inject(['settings'], (child) => {
          child.effect?.(() => {
            void ensureRingsSeeded()
            return () => undefined
          }, 'dex-model-control:rings-seed')
        })
      } else {
        void ensureRingsSeeded()
      }

      const catalog = async (sessionId?: string): Promise<ModelCatalog> => {
        await ensureRingsSeeded()
        const { llm, credentials, settings } = runtime()
        const providers = []
        for (const provider of llm.listProviders()) {
          const models = await llm.listModels(provider.id)
          let credential = { configured: false, writable: false }
          try {
            credential = await credentials.describe(credentialRef(provider.id))
          } catch {
            // Provider-native auth may not expose a writable API-key reference.
          }
          providers.push({ id: provider.id, name: provider.name, models: [...models], credential })
        }
        const liveIds = new Set(providers.map((provider) => provider.id))
        const configurable = (llm.listConfigurableProviders?.() ?? []).map((entry) => ({
          provider: entry.provider,
          displayName: entry.displayName,
          settingsNs: entry.settingsNs,
          settingsPath: [...entry.settingsPath],
          ...(entry.declared === undefined ? {} : { declared: entry.declared }),
          ...(entry.error === undefined ? {} : { error: entry.error }),
          live: liveIds.has(entry.provider),
        }))
        const defaultNs = settings
          .describe({ redactSecrets: true })
          .find((entry) => asRecord(entry)?.ns === 'agent-default-model')
        const defaultSelection = asSelection(asRecord(defaultNs)?.value)
        return modelCatalogSchema.parse({
          providers,
          configurable,
          selection: currentSelection(sessionId),
          defaultSelection,
        })
      }

      const workspaceList = (): ReturnType<typeof workspaceListSchema.parse> => {
        const registry = workspaceRegistry()
        const workspaces = registry.list().map((workspace) => workspaceViewOf(workspace))
        return workspaceListSchema.parse({
          workspaces,
          workspaceIds: workspaces.map((workspace) => workspace.workspaceId),
          archivedSessionIds: [...registry.archivedSessionIds],
          pinnedSessionIds: [...registry.pinnedSessionIds],
        })
      }

      const readEvents = async (
        sessionId: string,
      ): Promise<readonly ReturnType<typeof sessionEventSchema.parse>[]> => {
        const handle = await persistence().open(sessionId, 'read')
        try {
          const result = await handle.read()
          return result.events.map((event) => sessionEventSchema.parse(event))
        } finally {
          await handle.close()
        }
      }

      /**
       * 会话归属的权威事实：**会话头的 `cwd`**。
       *
       * 照抄 dsh 的规则（`@deepseek-ai/dsh-workspace` 的 `entity.ts:101`，
       * `sessionIds = record.sessionIds.filter(id => host.sessionPath(id) === record.path)`，
       * 而 `sessionPath` 在「header 缺失或 cwd 无法解析到现存目录」时返回 `undefined`）：
       * 这里做 `fs.realpath` 规范化 + 目录存在性确认，二者任一失败就不带 `cwd`，
       * 让渲染层把这条会话归入「未分组」——那是真孤儿，而不是「我们没记到」。
       */
      const workspaceCwdOf = (header: unknown): string | undefined => {
        const raw =
          header !== null && typeof header === 'object'
            ? (header as Record<string, unknown>).cwd
            : undefined
        if (typeof raw !== 'string' || raw === '') return undefined
        try {
          const resolved = realpathSync(raw)
          return statSync(resolved).isDirectory() ? resolved : undefined
        } catch {
          return undefined
        }
      }

      /**
       * 活体会话的实时标题。
       *
       * 为什么需要：`sessions/list` 读的是**落盘日志**，而 `session/title` 事件是异步
       * flush 的——刚重命名完立刻重读，磁盘上还是旧标题（实测）。dsh 官方客户端读的是
       * 宿主投影缓存，我们补这一层：活体会话以 `sessionTitle.get()` 为准，冷会话回退日志。
       */
      const liveTitleOf = (sessionId: string): string | undefined => {
        try {
          const session = sessionsStore()?.get(sessionId)
          if (session === undefined) return undefined
          const title = sessionTitle().get(session)?.title
          return title === undefined || title.trim() === '' ? undefined : title
        } catch {
          return undefined
        }
      }

      const listSessions = async (cursor?: string): Promise<SessionList> => {
        const offset = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0)
        const summaries = []
        for (const snapshot of await persistence().list()) {
          const cwd = workspaceCwdOf(snapshot.header)
          const liveTitle = liveTitleOf(snapshot.header.id)
          try {
            const events = await readEvents(snapshot.header.id)
            const summary = summarizeSessionEvents(
              snapshot.header.id,
              events,
              snapshot.header.createdAt,
              cwd,
            )
            summaries.push(liveTitle === undefined ? summary : { ...summary, title: liveTitle })
          } catch {
            summaries.push({
              sessionId: snapshot.header.id,
              title: liveTitle ?? snapshot.header.id,
              status: 'unknown' as const,
              taskCount: 0,
              ...(cwd === undefined ? {} : { cwd }),
              ...(snapshot.header.createdAt === undefined
                ? {}
                : { updatedAt: snapshot.header.createdAt }),
            })
          }
        }
        const sorted = sortSessionSummaries(summaries)
        const page = sorted.slice(offset, offset + 100)
        return {
          sessions: page,
          ...(offset + page.length < sorted.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
        }
      }

      const replaySession = async (sessionId: string): Promise<SessionReplay> => {
        const events = await readEvents(sessionId)
        let state = createInitialProjectionState(sessionId)
        for (const event of events) state = applySessionEvent(state, event)
        return { sessionId, traceState: state }
      }

      const handle = async (raw: unknown): Promise<ControlResponse> => {
        const parsed = controlRequestSchema.safeParse(raw)
        if (!parsed.success) {
          return controlFailure(
            asRecord(raw)?.requestId && typeof asRecord(raw)?.requestId === 'string'
              ? String(asRecord(raw)?.requestId)
              : 'unknown',
            controlError('BAD_REQUEST', 'invalid model control request'),
          )
        }
        const request = parsed.data
        try {
          if (request.method === 'models/list') {
            return controlResult(request.requestId, await catalog(request.sessionId))
          }
          if (request.method === 'sessions/list') {
            return controlResult(request.requestId, await listSessions(request.cursor))
          }
          if (request.method === 'sessions/replay') {
            return controlResult(request.requestId, await replaySession(request.sessionId))
          }
          if (request.method === 'sessions/cancel') {
            // 镜像 dsh `SessionCommands.cancel`（session-controller/src/commands.ts:518-532）：
            // 只取消活跃轮次，保留 inbox（`keepInbox`），避免用户顺手把排队的工作一起清掉。
            const agent = runtime().agents.get(request.sessionId)
            if (agent === undefined) {
              throw new Error(`会话 ${request.sessionId} 当前没有活跃 Agent，无法停止`)
            }
            if (typeof agent.cancel !== 'function') {
              throw new Error('当前 dsh 版本的 Agent 未提供 cancel 能力')
            }
            agent.cancel({ kind: 'user' }, { keepInbox: true })
            return controlResult(request.requestId, { accepted: true })
          }
          if (request.method === 'sessions/resume') {
            assertNotArchived(request.sessionId)
            // 幂等：已经是活体时 ensureLive 直接复用，不会再拿一次写占用。
            await agentSession.ensureLive(
              request.sessionId,
              request.selection === undefined ? null : asSelection(request.selection),
            )
            // 回读实际生效的模型，让界面拿它去校准下拉框（resume 用的是 agentOptions，
            // 与「界面上先选、再由 resume 生效」是同一件事的两个视角）。
            return controlResult(request.requestId, currentSelection(request.sessionId))
          }
          if (request.method === 'sessions/prompt') {
            assertNotArchived(request.sessionId)
            return controlResult(
              request.requestId,
              await agentSession.deliver(
                request.sessionId,
                request.content,
                request.mode ?? 'followup',
              ),
            )
          }
          if (request.method === 'settings/describe') {
            const { settings } = runtime()
            const descriptor = settingsDescribeSchema.parse({
              writable: settings.writable,
              hasDocument: settings.documentPath !== undefined,
              namespaces: settings.describe({ redactSecrets: true }).map((entry) => {
                const value = asRecord(entry)
                return value === null ? entry : { secrets: [], ...value }
              }),
            })
            return controlResult(request.requestId, descriptor)
          }
          if (request.method === 'settings/mutate') {
            const { settings } = runtime()
            if (!settings.writable) throw new Error('当前 dsh profile 的全局设置为只读')
            await settings.mutate(request.namespace, request.operations, request.expectedRevision)
            const namespace = settings
              .describe({ redactSecrets: true })
              .find((entry) => asRecord(entry)?.ns === request.namespace)
            if (namespace === undefined) {
              throw new Error(`设置分组 ${request.namespace} 写入后已不可用`)
            }
            const parsedNamespace = settingsMutateResultSchema.parse({
              secrets: [],
              ...(asRecord(namespace) ?? {}),
            })
            return controlResult(request.requestId, parsedNamespace)
          }
          if (request.method === 'plugins/list') {
            return controlResult(request.requestId, await pluginsListPayload())
          }
          if (request.method === 'plugins/set-enabled') {
            const manager = pluginManager()
            if (manager === null) {
              throw new Error('当前 dsh profile 未提供插件管理服务')
            }
            // 上游 `change()` 把业务失败收敛进返回值（`application:'failed'` + error.code），
            // 这里转成控制面统一的结构化错误；失败不落进「成功结果」骗 UI。
            const raw = asRecord(await manager.setPluginEnabled(request.entryId, request.enabled))
            const errorRecord = asRecord(raw?.error)
            const result: PluginChangeResult = pluginChangeResultSchema.parse({
              changed: raw?.changed === true,
              application: raw?.application,
              ...(typeof raw?.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
              ...(typeof errorRecord?.code === 'string' ? { errorCode: errorRecord.code } : {}),
              ...(Array.isArray(raw?.warnings)
                ? {
                    warnings: (raw.warnings as readonly unknown[]).filter(
                      (item): item is string => typeof item === 'string',
                    ),
                  }
                : {}),
            })
            if (result.application === 'failed') {
              const failure = pluginFailureOf(result.errorCode)
              return controlFailure(
                request.requestId,
                controlError(failure.code, failure.message, failure.retryable),
              )
            }
            return controlResult(request.requestId, result)
          }
          if (request.method === 'sessions/rename') {
            // 冷会话先恢复成活体（与 dsh controller 的 resolveAgent 同义）。
            await agentSession.ensureLive(request.sessionId, null)
            const session = sessionsStore()?.get(request.sessionId)
            if (session === undefined) {
              throw new Error(`会话 ${request.sessionId} 未激活，无法重命名`)
            }
            const snapshot = sessionTitle().rename(session, request.title)
            return controlResult(
              request.requestId,
              sessionRenameResultSchema.parse({ title: snapshot.title, seq: snapshot.eventSeq }),
            )
          }
          if (request.method === 'sessions/archive') {
            const result = await workspaceController().archiveSession({
              sessionId: request.sessionId,
              ...(request.stopActivity === undefined ? {} : { stopActivity: request.stopActivity }),
            })
            return controlResult(request.requestId, archivedSessionsResultSchema.parse(result))
          }
          if (request.method === 'sessions/unarchive') {
            const result = await workspaceController().unarchiveSession({
              sessionId: request.sessionId,
            })
            return controlResult(request.requestId, archivedSessionsResultSchema.parse(result))
          }
          if (request.method === 'sessions/delete') {
            const result = await deleteOrphanSessionLog(request.sessionId)
            return controlResult(request.requestId, sessionDeleteResultSchema.parse(result))
          }
          if (request.method === 'sessions/pin') {
            const result = await workspaceController().pinSession({ sessionId: request.sessionId })
            return controlResult(request.requestId, pinnedSessionsResultSchema.parse(result))
          }
          if (request.method === 'sessions/unpin') {
            const result = await workspaceController().unpinSession({
              sessionId: request.sessionId,
            })
            return controlResult(request.requestId, pinnedSessionsResultSchema.parse(result))
          }
          if (request.method === 'workspaces/list') {
            return controlResult(request.requestId, workspaceList())
          }
          if (request.method === 'workspaces/create') {
            const result = await workspaceController().create({ path: request.path })
            return controlResult(
              request.requestId,
              workspaceCreateResultSchema.parse({
                workspace: workspaceViewOf(result.workspace),
                created: result.created,
              }),
            )
          }
          if (request.method === 'workspaces/rename') {
            const result = await workspaceController().rename({
              workspaceId: request.workspaceId,
              title: request.title,
            })
            return controlResult(
              request.requestId,
              workspaceRenameResultSchema.parse({
                workspace: workspaceViewOf(result.workspace),
              }),
            )
          }
          if (request.method === 'workspaces/delete') {
            const result = await workspaceController().delete({ workspaceId: request.workspaceId })
            return controlResult(request.requestId, workspaceDeleteResultSchema.parse(result))
          }
          if (request.method === 'workspaces/insertBefore') {
            const result = await workspaceController().insertBefore({
              workspaceId: request.workspaceId,
              ...(request.beforeWorkspaceId === undefined
                ? {}
                : { beforeWorkspaceId: request.beforeWorkspaceId }),
            })
            return controlResult(request.requestId, workspaceOrderResultSchema.parse(result))
          }
          if (request.method === 'models/discover') {
            const { llm } = runtime()
            if (llm.discoverModels === undefined) {
              throw new Error('当前 dsh 版本不支持模型发现')
            }
            const models = await llm.discoverModels(request.discovery.namespace, {
              ...(request.discovery.provider === undefined
                ? {}
                : { provider: request.discovery.provider }),
              ...(request.discovery.baseURL === undefined
                ? {}
                : { baseURL: request.discovery.baseURL }),
              ...(request.discovery.api === undefined ? {} : { api: request.discovery.api }),
              ...(request.discovery.apiKey === undefined
                ? {}
                : { apiKey: request.discovery.apiKey }),
            })
            return controlResult(
              request.requestId,
              models.map((model) => discoveredModelSchema.parse(model)),
            )
          }
          if (request.method === 'models/select') {
            const agent = runtime().agents.get(request.sessionId)
            const ref = selections.get(request.sessionId) ?? { current: request.selection }
            if (agent === undefined) {
              // Dex 保留「先暂存选择、恢复时再应用」的行为；与 dsh host `selectModel`
              // 不同，这里不因模型选择单独恢复冷会话（只有 activate/prompt 会恢复）。
              ref.current = request.selection
              selections.set(request.sessionId, ref)
              return controlResult(request.requestId, request.selection)
            }
            await installSelection(agent, request.selection, ref)
            selections.set(request.sessionId, ref)
            return controlResult(request.requestId, request.selection)
          }
          const ref = credentialRef(request.provider)
          if (request.method === 'credentials/set') {
            await runtime().credentials.set(ref, request.apiKey)
          } else {
            await runtime().credentials.unset(ref)
          }
          return controlResult(request.requestId, {
            provider: request.provider,
            configured: request.method === 'credentials/set',
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'model control failed'
          const rawCode = asRecord(error)?.code
          const code =
            typeof rawCode === 'string'
              ? rawCode
              : error instanceof Error && error.name === 'SessionTitleInvalidError'
                ? 'session/title-invalid'
                : undefined
          // dsh 的 RemoteError 文案是英文诊断；这里把控制面会遇到的几类翻成人话，
          // 并保留稳定机器码供 UI 分支（如「停止并归档」确认框）。
          const known: Record<string, { code: string; message: string; retryable: boolean }> = {
            'session/title-invalid': {
              code: 'SESSION_TITLE_INVALID',
              message: '会话标题不能为空或只含不可见字符',
              retryable: false,
            },
            'session/not-found': {
              code: 'SESSION_NOT_FOUND',
              message: '找不到该会话',
              retryable: false,
            },
            'workspace/session-active': {
              code: 'SESSION_ACTIVE',
              message: '该会话还有正在运行的工作；可改用「停止并归档」',
              retryable: true,
            },
            'session/archived': {
              code: 'SESSION_ARCHIVED',
              message: '该会话已归档，请先取消归档再继续对话',
              retryable: false,
            },
            'dex/session-workspace-bound': {
              code: 'SESSION_WORKSPACE_BOUND',
              message: '该会话仍属于有效工作区，请使用删除会话（归档）',
              retryable: false,
            },
            'workspace/name-conflict': {
              code: 'WORKSPACE_NAME_CONFLICT',
              message: '已存在同名工作区',
              retryable: false,
            },
            'workspace/not-found': {
              code: 'WORKSPACE_NOT_FOUND',
              message: '找不到该工作区',
              retryable: false,
            },
            'workspace/invalid-path': {
              code: 'WORKSPACE_INVALID_PATH',
              message: '目录不可用（不存在或不是目录）',
              retryable: false,
            },
            'workspace/move-invalid': {
              code: 'WORKSPACE_MOVE_INVALID',
              message: '目标位置无效',
              retryable: false,
            },
            'llm/model-discovery-rejected': {
              code: 'MODEL_DISCOVERY_REJECTED',
              message: '提供商拒绝了模型列表请求',
              retryable: true,
            },
          }
          const mapped = code === undefined ? undefined : known[code]
          if (mapped !== undefined) {
            return controlFailure(
              request.requestId,
              controlError(mapped.code, mapped.message, mapped.retryable),
            )
          }
          return controlFailure(
            request.requestId,
            controlError(
              code === 'SETTINGS_CONFLICT' ? 'SETTINGS_CONFLICT' : 'CONTROL_FAILED',
              message,
              code === 'SETTINGS_CONFLICT',
            ),
          )
        }
      }

      log(`registering route ${routePath}`)
      const unregister = ctx.webServer.registerUpgrade({
        path: routePath,
        handler(req: IncomingMessage, socket: Duplex, head: Buffer) {
          log(`upgrade ${req.url ?? ''}`)
          server.handleUpgrade(req, socket, head, (ws) => {
            ws.on('message', (data) => {
              let raw: unknown
              try {
                raw = JSON.parse(String(data))
              } catch {
                return
              }
              void handle(raw).then((response) => {
                if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(response))
              })
            })
          })
        },
      })
      // fiber 卸载：注销路由并关闭 server（agent handle 释放由上方 effect 负责）。
      ctx.effect?.(
        () => () => {
          unregister()
          server.close()
        },
        'dex-model-control:websocket',
      )
      log(`route registered ${routePath}`)
    },
  }
}

const host = createDexModelControlHost()
export default host
