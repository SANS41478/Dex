import {
  type ApprovalPolicy,
  type ModelSelection,
  type PermissionPreset,
  type ReasoningEffort,
  resolveReasoningEffort,
  sessionActivateResultSchema,
  sessionCreateResultSchema,
  sessionPromptResultSchema,
  workspaceFilesPickResultSchema,
} from '@dexagent/shared'
import { create } from 'zustand'
import { pickDefaultSelection } from '../core/model-default'
import { findReusableBlankSession } from '../core/session-list'
import { rememberActiveSession } from '../core/session-restore'
import { normalizeWorkspacePath, type WorkspaceRecord } from '../core/workspaces'
import { useHostStore } from './hostStore'
import { useHostWorkspaceStore } from './hostWorkspaceStore'
import { useModelStore } from './modelStore'
import { useNavigationStore } from './navigationStore'
import { useSessionStatusStore } from './sessionStatusStore'
import { useSessionStore } from './sessionStore'
import { useSessionUnreadStore } from './sessionUnreadStore'
import { useTraceStore } from './traceStore'
import { useWorkspaceStore } from './workspaceStore'

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'system'
  readonly content: string
  readonly status: 'completed' | 'failed'
  readonly createdAt: number
}

export interface ChatAttachment {
  readonly path: string
  readonly kind: 'file' | 'image'
}

export interface LocalBlankSession {
  readonly sessionId: string
  readonly workspacePath: string
}

export type { PermissionPreset } from '@dexagent/shared'

export interface ChatStore {
  activeSessionId: string | null
  /**
   * 当前会话所属工作区。`activeSessionId !== null` 时它必然非空，
   * 与 `workspacePath` 一起构成“会话必须绑定工作区”的不变量。
   */
  workspaceId: string | null
  workspacePath: string | null
  blankSessions: readonly LocalBlankSession[]
  messages: readonly ChatMessage[]
  /**
   * 当前会话是否正在执行任务。
   *
   * **这不是本地事实，而是宿主 `session.status` 的投影**：`send` 只做乐观置位，
   * 真正的清零由宿主发出 `idle` 完成（见本文件底部的订阅）。早先的实现只在 `send`
   * 的 catch 分支清零，成功路径永不清零——界面因此从第一条消息起就永久停在
   * 「正在执行任务」。
   */
  sending: boolean
  /** 本轮开始时刻：给「正在执行任务」气泡一个**稳定**的排序时间戳（见 `core/chat.ts`）。 */
  sendingSince: number | null
  /** 已请求停止、正在等宿主回到 `idle`。用于把按钮切成「停止中…」并禁止重复点击。 */
  stopping: boolean
  error: string | null
  /** 上一次发送失败时的原文，供 Composer 的「重发」按钮复用；成功或重发后清空。 */
  failedPrompt: string | null
  attachments: readonly ChatAttachment[]
  permissionPreset: PermissionPreset
  approvalPolicy: ApprovalPolicy
  /**
   * 本轮要发的推理档位。默认 `off` = **不带 `reasoningEffort` 参数**，由模型/网关定夺。
   *
   * 早先默认写死 `'medium'`（替模型做了决定），而默认模型 `deepseek-flash` 恰恰不支持
   * medium，于是「默认配置下第一次发消息必失败」（黑盒报告 D01）。
   */
  reasoningEffort: ReasoningEffort
  newSession: (workspace?: WorkspaceRecord, selection?: ModelSelection | null) => Promise<void>
  activate: (sessionId: string, workspacePath: string) => Promise<void>
  pickAttachments: () => Promise<void>
  removeAttachment: (path: string) => void
  setPermissionPreset: (preset: PermissionPreset) => void
  setApprovalPolicy: (policy: ApprovalPolicy) => void
  setReasoningEffort: (effort: ReasoningEffort) => void
  send: (content: string) => Promise<void>
  /** 重发上一次失败的文本：先撤掉失败留下的回显与错误行，再走一次 send。 */
  resend: () => Promise<void>
  /**
   * 往消息流里追加一条系统提示（不是错误）。
   *
   * 用途是「降级但不静默」：权限档位被 runtime 降级、选中的 provider 还没写 API key……
   * 这类事不该让整轮失败，但也不能什么都不说——过去静默正是黑盒报告 D03/D05/D18 的共同根因。
   */
  noteSystem: (text: string) => void
  /** 请求宿主取消当前轮次（dsh `agent.cancel`）。 */
  stop: () => Promise<void>
  clear: (options?: { readonly forgetBlank?: boolean }) => void
}

function unavailable(): Error {
  return new Error('coding agent 仅在 Electron 宿主中可用')
}

export const useChatStore = create<ChatStore>((set, get) => ({
  activeSessionId: null,
  workspaceId: null,
  workspacePath: null,
  blankSessions: [],
  messages: [],
  sending: false,
  sendingSince: null,
  stopping: false,
  error: null,
  failedPrompt: null,
  attachments: [],
  permissionPreset: 'workspace-write',
  approvalPolicy: 'ask',
  reasoningEffort: 'off',
  newSession: async (target, selection) => {
    if (typeof window.dex === 'undefined') throw unavailable()
    const current = get()
    const workspaceState = useWorkspaceStore.getState()
    const currentWorkspace =
      current.workspaceId === null
        ? undefined
        : workspaceState.workspaces.find((item) => item.id === current.workspaceId)
    const activeWorkspace =
      workspaceState.activeWorkspaceId === null
        ? undefined
        : workspaceState.workspaces.find((item) => item.id === workspaceState.activeWorkspaceId)
    const recentWorkspace = workspaceState.workspaces.reduce<WorkspaceRecord | undefined>(
      (latest, item) =>
        latest === undefined || item.lastUsedAt > latest.lastUsedAt ? item : latest,
      undefined,
    )
    const resolved = target ?? currentWorkspace ?? activeWorkspace ?? recentWorkspace
    if (resolved === undefined) {
      throw Object.assign(new Error('请先添加或选择一个工作区'), { code: 'NO_WORKSPACE' })
    }
    const workspace = workspaceState.register(resolved.path)
    const hostWorkspaceState = useHostWorkspaceStore.getState()
    hostWorkspaceState.restorePath(workspace.path)
    if (
      window.dex.workspaces !== undefined &&
      hostWorkspaceState.workspaceForPath(workspace.path) === undefined
    ) {
      await hostWorkspaceState.create(workspace.path)
    }
    await useSessionStore.getState().load()
    const currentIsBlank =
      current.activeSessionId !== null &&
      current.workspacePath !== null &&
      current.messages.length === 0 &&
      useTraceStore.getState().turns.length === 0 &&
      normalizeWorkspacePath(current.workspacePath) === normalizeWorkspacePath(workspace.path)
    if (currentIsBlank) {
      set({ workspaceId: workspace.id, workspacePath: current.workspacePath })
      return
    }

    const persistedBlank = findReusableBlankSession({
      sessions: useSessionStore.getState().sessions,
      sessionWorkspace: workspaceState.sessionWorkspace,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
    })
    const localBlank = get().blankSessions.find(
      (candidate) =>
        normalizeWorkspacePath(candidate.workspacePath) ===
          normalizeWorkspacePath(workspace.path) &&
        useSessionStore
          .getState()
          .sessions.find((session) => session.sessionId === candidate.sessionId)?.blank !== false,
    )
    const reusableId = persistedBlank?.sessionId ?? localBlank?.sessionId
    if (reusableId !== undefined) {
      await get().activate(reusableId, workspace.path)
      return
    }

    if (useModelStore.getState().catalog.providers.length === 0) {
      await useModelStore
        .getState()
        .load()
        .catch(() => undefined)
    }
    const preferred = selection ?? pickDefaultSelection(useModelStore.getState().catalog)
    const created = sessionCreateResultSchema.parse(
      await window.dex.session.create({
        workspacePath: workspace.path,
        ...(preferred === null ? {} : { selection: preferred }),
      }),
    )
    useTraceStore.getState().clear()
    useWorkspaceStore.getState().linkSession(created.sessionId, workspace)
    useWorkspaceStore.getState().activate(workspace.id)
    set({
      activeSessionId: created.sessionId,
      workspaceId: workspace.id,
      workspacePath: created.workspacePath,
      blankSessions: [
        ...get().blankSessions.filter((candidate) => candidate.sessionId !== created.sessionId),
        { sessionId: created.sessionId, workspacePath: workspace.path },
      ],
      messages: [],
      sending: false,
      sendingSince: null,
      stopping: false,
      error: null,
      failedPrompt: null,
      attachments: [],
    })
    useNavigationStore.getState().push(created.sessionId)
    rememberActiveSession({
      sessionId: created.sessionId,
      workspacePath: created.workspacePath,
    })
  },
  activate: async (sessionId, workspacePath) => {
    if (typeof window.dex === 'undefined') throw unavailable()
    const previous = get()
    const previousIsBlank =
      previous.activeSessionId !== null &&
      previous.activeSessionId !== sessionId &&
      previous.workspacePath !== null &&
      previous.messages.length === 0 &&
      useTraceStore.getState().turns.length === 0
    const workspace = useWorkspaceStore.getState().register(workspacePath)
    // 历史会话要在宿主侧 resume（D33）——`agents.resume({ agentOptions })` 需要模型，
    // 所以把界面上当前选中的选择一并带上；没有选择时挑一个默认值（理由同 newSession），
    // 都没有才交给宿主决定（dsh 默认模型）。
    const selection =
      useModelStore.getState().catalog.selection ??
      pickDefaultSelection(useModelStore.getState().catalog)
    const activated = sessionActivateResultSchema.parse(
      await window.dex.session.activate({
        sessionId,
        workspacePath: workspace.path,
        ...(selection === null ? {} : { selection }),
      }),
    )
    const bound = useWorkspaceStore.getState().register(activated.workspacePath)
    useWorkspaceStore.getState().linkSession(activated.sessionId, bound)
    useWorkspaceStore.getState().activate(bound.id)
    set({
      activeSessionId: activated.sessionId,
      workspaceId: bound.id,
      workspacePath: activated.workspacePath,
      blankSessions: [
        ...get().blankSessions.filter((candidate) => candidate.sessionId !== activated.sessionId),
        ...(previousIsBlank && previous.workspacePath !== null && previous.activeSessionId !== null
          ? [{ sessionId: previous.activeSessionId, workspacePath: previous.workspacePath }]
          : []),
      ],
      messages: [],
      sending: false,
      sendingSince: null,
      stopping: false,
      error: null,
      failedPrompt: null,
      attachments: [],
    })
    useNavigationStore.getState().push(activated.sessionId)
    useSessionUnreadStore.getState().markRead(activated.sessionId)
    useTraceStore.getState().clear()
    // 记下「上次打开的会话」，供刷新 / 重载后恢复（D08）。
    rememberActiveSession({
      sessionId: activated.sessionId,
      workspacePath: activated.workspacePath,
    })
  },
  pickAttachments: async () => {
    if (typeof window.dex === 'undefined') throw unavailable()
    const picked = workspaceFilesPickResultSchema.parse(await window.dex.workspace.pickFiles())
    if (picked.canceled) return
    const attachments = picked.files.map((path) => ({
      path,
      kind: /\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? ('image' as const) : ('file' as const),
    }))
    set((state) => ({
      attachments: [
        ...state.attachments,
        ...attachments.filter(
          (item) => !state.attachments.some((entry) => entry.path === item.path),
        ),
      ],
    }))
  },
  removeAttachment: (path) =>
    set((state) => ({ attachments: state.attachments.filter((item) => item.path !== path) })),
  setPermissionPreset: (permissionPreset) => set({ permissionPreset }),
  setApprovalPolicy: (approvalPolicy) => set({ approvalPolicy }),
  setReasoningEffort: (reasoningEffort) => set({ reasoningEffort }),
  send: async (content) => {
    const text = content.trim()
    const sessionId = get().activeSessionId
    if (text === '' || sessionId === null) return
    if (get().sending) return
    if (typeof window.dex === 'undefined') {
      set({ error: unavailable().message })
      return
    }
    const startedAt = Date.now()
    const message: ChatMessage = {
      id: `local-${startedAt}`,
      role: 'user',
      content: text,
      status: 'completed',
      createdAt: startedAt,
    }
    set((state) => ({
      messages: [...state.messages, message],
      sending: true,
      sendingSince: startedAt,
      stopping: false,
      error: null,
      failedPrompt: null,
    }))
    try {
      const state = get()
      // 发送边界的兜底：把「界面上的档位」收敛成「该模型真能接受的档位」。
      // 界面已按能力置灰，这里是防手滑与防协议绕过的第二道闸（见 shared/reasoning.ts）。
      const selection = useModelStore.getState().catalog.selection
      const reasoningEffort = resolveReasoningEffort(
        selection?.provider,
        selection?.model,
        state.reasoningEffort,
      )
      const result = sessionPromptResultSchema.parse(
        await window.dex.session.prompt({
          sessionId,
          content: text,
          ...(state.attachments.length === 0 ? {} : { attachments: state.attachments }),
          permissionPreset: state.permissionPreset,
          approvalPolicy: state.approvalPolicy,
          reasoningEffort,
        }),
      )
      useSessionStore.getState().markNonBlank(sessionId)
      set((current) => ({
        blankSessions: current.blankSessions.filter(
          (candidate) => candidate.sessionId !== sessionId,
        ),
      }))
      // 宿主降级执行时的说明（如权限档位不被 runtime 支持）——**降级但不静默**。
      // 只进消息流、不写 `error`，免得同一句话在输入框旁再显示一遍。
      if (result.notice !== undefined) get().noteSystem(result.notice)
      // 成功路径**刻意不清零** `sending`：一轮任务在 prompt 被受理后才真正开始，
      // 清零是宿主 `idle` 的职责（见文件底部的会话状态订阅）。
      set({ error: null, failedPrompt: null, attachments: [] })
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '发送任务失败'
      // **不再往 messages 里追加一条 system 气泡**：`core/chat.ts` 已经用 `error`
      // 合成了一条 `error:latest` 行，Composer 里还有一处行内提示（带「重发」）。
      // 三处都写，用户会在消息流里看到同一句话连着出现两次（黑盒报告 D05）。
      set({
        sending: false,
        sendingSince: null,
        stopping: false,
        error: messageText,
        failedPrompt: text,
      })
    }
  },
  noteSystem: (text) => {
    const content = text.trim()
    if (content === '') return
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `notice-${Date.now()}-${state.messages.length}`,
          role: 'system',
          content,
          status: 'completed',
          createdAt: Date.now(),
        },
      ],
    }))
  },
  resend: async () => {
    const prompt = get().failedPrompt
    if (prompt === null) return
    // 先撤掉上一次失败留下的痕迹：本地乐观回显（local-*）与错误行（error-*）。
    // 不清的话，重发会再追加一条同样的用户消息，列表里就出现两次。
    // 历史轮次由 trace 事件重建（core/chat.ts），清 local 行不影响已落定的消息。
    set((state) => ({
      messages: state.messages.filter(
        (message) => !message.id.startsWith('local-') && !message.id.startsWith('error-'),
      ),
      error: null,
      failedPrompt: null,
    }))
    await get().send(prompt)
  },
  stop: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null || !get().sending || get().stopping) return
    if (typeof window.dex === 'undefined') return
    set({ stopping: true, error: null })
    try {
      await window.dex.session.stop(sessionId)
      // 不在此处清零 `sending`：取消是**异步**的，宿主回到 idle 才算真的停。
      // 提前清零会让输入框解锁，用户再发一条会撞上 SESSION_BUSY。
    } catch (error) {
      set({
        stopping: false,
        error: error instanceof Error ? error.message : '停止任务失败',
      })
    }
  },
  clear: (options) => {
    const current = get()
    const isBlank =
      current.activeSessionId !== null &&
      current.workspacePath !== null &&
      current.messages.length === 0 &&
      useTraceStore.getState().turns.length === 0
    if (isBlank && options?.forgetBlank !== true) {
      set((state) => ({
        blankSessions: [
          ...state.blankSessions.filter(
            (candidate) => candidate.sessionId !== current.activeSessionId,
          ),
          {
            sessionId: current.activeSessionId as string,
            workspacePath: current.workspacePath as string,
          },
        ],
      }))
    }
    useTraceStore.getState().clear()
    set({
      activeSessionId: null,
      workspaceId: null,
      workspacePath: null,
      messages: [],
      sending: false,
      sendingSince: null,
      stopping: false,
      error: null,
      failedPrompt: null,
      attachments: [],
    })
  },
}))

/**
 * 宿主 `session.status` → `sending`。
 *
 * 只认**跃迁**（`running` → `idle`），不认当前值：WS 重连时 main 会把每个会话的最新
 * 状态作为基线重放一次，若按「看到 idle 就清零」处理，会把刚提交、还没开始跑的请求
 * 误判成「已结束」。
 */
useSessionStatusStore.subscribe((state, previous) => {
  const sessionId = useChatStore.getState().activeSessionId
  if (sessionId === null) return
  const next = state.statuses[sessionId]
  if (next !== 'idle') return
  if (previous.statuses[sessionId] !== 'running') return
  useChatStore.setState({ sending: false, sendingSince: null, stopping: false })
})

/**
 * 宿主离开可用状态 → 兜底清零。
 *
 * 若宿主进程死掉（`error` / `stopped`）或压根没找到 CLI（`missing`），任何「执行中」
 * 都不可能继续；此时不该让界面永远转圈。这是 `session.status` 之外的**第二条**收尾路径，
 * 用于覆盖「运行中宿主崩溃」这种通知永远到不了的场景。
 */
useHostStore.subscribe((state, previous) => {
  if (state.phase === previous.phase) return
  if (state.phase === 'ready' || state.phase === 'starting' || state.phase === 'unknown') return
  if (!useChatStore.getState().sending) return
  useChatStore.setState({ sending: false, sendingSince: null, stopping: false })
})
