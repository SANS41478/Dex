import { stat } from 'node:fs/promises'
import {
  type AppError,
  type ModelSelection,
  runtimePolicyNotice,
  type SessionActivateResult,
  type SessionCreateResult,
  sessionActivateRequestSchema,
  sessionActivateResultSchema,
  sessionCreateRequestSchema,
  sessionCreateResultSchema,
  sessionPromptRequestSchema,
  sessionPromptResultSchema,
  sessionStopRequestSchema,
  sessionStopResultSchema,
  workspaceFilesPickResultSchema,
  workspacePickResultSchema,
} from '@dexagent/shared'
import { dialog, ipcMain } from 'electron'
import { relativeAttachment } from './attachment-path'
import type { DshHost } from './dsh-host'
import {
  type ActiveSession,
  mapPromptFailure,
  mapResumeFailure,
  mapStopFailure,
  SessionRegistry,
  sessionNotResumableError,
} from './session-registry'

export type SessionIpcResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: AppError }

export interface SessionIpcOptions {
  readonly onPromptStarted?: () => void
  /**
   * 取消该会话的活跃轮次。
   *
   * SDK stdio 面（`initialize` / `session/prompt` / `shutdown`）没有 cancel 方法，
   * 所以停止只能走 `/dex-control` → 桥接插件 → `agent.cancel({kind:'user'})`。
   * 缺省时停止按钮如实上报「未提供」而不是假装成功。
   */
  readonly cancelSession?: ((sessionId: string) => Promise<void>) | undefined
  /**
   * 在宿主侧把磁盘上的历史会话恢复成活体（`/dex-control` → `sessions/resume`）。
   *
   * 只在「打开一个未登记的历史会话」时调用，且**成功之后才登记**——失败就地返回，
   * renderer 的 `SessionPanel` 会退化为只读回放。缺省（demo 模式 / 无控制通道）时
   * 历史会话保持只读：如实降级，而不是假装能聊。
   */
  readonly resumeSession?:
    | ((input: {
        readonly sessionId: string
        readonly selection?: ModelSelection
      }) => Promise<ModelSelection | null>)
    | undefined
  /**
   * 通过控制桥往**已恢复**的会话投递一条消息。
   *
   * 与 SDK stdio 的 `session/prompt` 是同一件事的两条实现：SDK 只能喂本进程新建的
   * 会话，控制桥能喂任何活体会话。
   */
  readonly promptViaControl?:
    | ((input: { readonly sessionId: string; readonly content: string }) => Promise<void>)
    | undefined
}

function failure(code: string, message: string, retryable = false): SessionIpcResponse {
  return { ok: false, error: { code, message, retryable } }
}

function failed(error: AppError): SessionIpcResponse {
  return { ok: false, error }
}

function success(result: unknown): SessionIpcResponse {
  return { ok: true, result }
}

async function validWorkspace(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 没有显式选择时的默认模型。
 *
 * 与 `session.create` 共用同一份兜底，避免「新建会话走 rings、续聊历史会话走别的
 * provider」这种两套默认值打架的情况。
 */
function defaultSelection(): {
  provider: string
  model: string
  reasoningEffort?: string
} {
  return {
    provider: process.env.DEX_DEFAULT_PROVIDER ?? 'rings',
    model: process.env.DEX_DEFAULT_MODEL ?? 'gpt-6-luna',
  }
}

/** 附件统一以文本行附加（SDK stdio 面与控制桥面用同一份措辞）。 */
function withAttachments(content: string, attachments: readonly { path: string }[]): string {
  if (attachments.length === 0) return content
  return `${content}\n\n[附件]\n${attachments.map((item) => `- ${item.path}`).join('\n')}`
}

export function registerSessionIpc(host: DshHost, options: SessionIpcOptions = {}): () => void {
  // 可继续对话的会话**只**以本进程登记表为准：dsh SDK 的 session/prompt 只能创建
  // 会话、不能恢复磁盘上的旧会话。历史会话走只读回放。
  const registry = new SessionRegistry()
  let initializedWorkspacePath: string | null = null
  let promptSequence = 0

  const pick = 'dex.workspace.pick'
  const pickFiles = 'dex.workspace.pickFiles'
  const create = 'dex.session.create'
  const activate = 'dex.session.activate'
  const prompt = 'dex.session.prompt'
  const stop = 'dex.session.stop'

  ipcMain.handle(pick, async (): Promise<SessionIpcResponse> => {
    const fixturePath = process.env.DEX_E2E_WORKSPACE_ROOT
    if (fixturePath !== undefined && (await validWorkspace(fixturePath))) {
      return success({ canceled: false, path: fixturePath })
    }
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择 coding agent 工作区',
    })
    const parsed = workspacePickResultSchema.parse(
      result.canceled || result.filePaths[0] === undefined
        ? { canceled: true }
        : { canceled: false, path: result.filePaths[0] },
    )
    return success(parsed)
  })

  ipcMain.handle(pickFiles, async (): Promise<SessionIpcResponse> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择要附加的工作区文件',
    })
    return success(
      workspaceFilesPickResultSchema.parse(
        result.canceled || result.filePaths.length === 0
          ? { canceled: true }
          : { canceled: false, files: result.filePaths },
      ),
    )
  })

  ipcMain.handle(create, async (_event, raw: unknown): Promise<SessionIpcResponse> => {
    const parsed = sessionCreateRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('BAD_REQUEST', '工作区参数无效')
    if (!(await validWorkspace(parsed.data.workspacePath))) {
      return failure('WORKSPACE_INVALID', '工作区目录不存在或不可访问')
    }

    const selection = parsed.data.selection ?? defaultSelection()
    const sessionId = registry.nextSessionId()
    const context: ActiveSession = {
      sessionId,
      workspacePath: parsed.data.workspacePath,
      provider: selection.provider,
      model: selection.model,
      // 新建会话归 SDK stdio 通道：dsh 的 SDK 服务器手里有这个 id。
      channel: 'stdio',
      busy: false,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
    }
    registry.register(context)
    const result: SessionCreateResult = {
      sessionId,
      workspacePath: parsed.data.workspacePath,
    }
    return success(sessionCreateResultSchema.parse(result))
  })

  ipcMain.handle(activate, async (_event, raw: unknown): Promise<SessionIpcResponse> => {
    const parsed = sessionActivateRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('BAD_REQUEST', '会话激活参数无效')
    if (!(await validWorkspace(parsed.data.workspacePath))) {
      return failure('WORKSPACE_INVALID', '工作区目录不存在或不可访问')
    }
    const { sessionId } = parsed.data
    const registered = registry.find(sessionId)
    // 先过守卫：宿主侧 resume 是有代价的动作（读整份日志、拿写占用），
    // 不该在「切不过去」的前提下白做。
    const blocked = registry.canActivate()
    if (blocked !== null) return failed(blocked)

    let activated: ModelSelection | null = null
    if (registered === undefined) {
      const requested = parsed.data.selection
      const resumeSession = options.resumeSession
      // 未登记 + 没有控制通道：只可能是磁盘上的历史会话，如实拒绝。
      // renderer 侧据此退化为只读回放（SessionPanel 的 catch 分支）。
      if (resumeSession === undefined) return failed(sessionNotResumableError(sessionId))
      try {
        activated = await resumeSession({
          sessionId,
          ...(requested === undefined ? {} : { selection: requested }),
        })
      } catch (error) {
        // 恢复失败 = 这个会话确实续不了 → 让界面退化为只读回放，而不是留在半开状态。
        return failed(mapResumeFailure(error, sessionId))
      }
    }

    const selection = activated ?? parsed.data.selection ?? defaultSelection()
    const adopted: Omit<ActiveSession, 'busy'> = {
      sessionId,
      workspacePath: parsed.data.workspacePath,
      provider: selection.provider,
      model: selection.model,
      channel: 'control',
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
    }
    const switched = registry.activate(sessionId, registered === undefined ? adopted : undefined)
    if (switched !== null) return failed(switched)
    const context = registry.find(sessionId)
    if (context === undefined) return failure('SESSION_NOT_ACTIVE', '当前没有这个会话', true)
    const result: SessionActivateResult = {
      sessionId,
      workspacePath: context.workspacePath,
    }
    return success(sessionActivateResultSchema.parse(result))
  })

  ipcMain.handle(prompt, async (_event, raw: unknown): Promise<SessionIpcResponse> => {
    const parsed = sessionPromptRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('BAD_REQUEST', 'prompt 参数无效')
    const active = registry.find(parsed.data.sessionId)
    if (registry.activeSessionId !== parsed.data.sessionId || active === undefined) {
      return failure('SESSION_NOT_ACTIVE', '当前没有这个活跃会话', true)
    }
    if (active.busy) return failure('SESSION_BUSY', '当前会话正在执行任务')
    active.busy = true
    try {
      // 权限 / 审批档位：runtime 不支持时**降级执行**，不再拒绝发送。
      //
      // 原实现在这里直接 `failure('POLICY_UNSUPPORTED', ...)`，把整轮挡在入口——于是
      // 真正的原因（模型不支持该推理档位、provider 缺凭据）被这句权限报错顶掉，
      // 用户被引向「去调权限」这个完全错误的方向（黑盒报告 D04）。
      // 界面侧已把不支持的档位置灰（见 shared/policy.ts 与 Composer），这里只做兜底，
      // 并把降级事实如实带回给界面（`notice`），做到「降级但不静默」。
      const policyNotice = runtimePolicyNotice(parsed.data)
      const noticeField = policyNotice === null ? {} : { notice: policyNotice }
      const attachments = (parsed.data.attachments ?? []).map((attachment) => {
        const path = relativeAttachment(active.workspacePath, attachment.path)
        if (path === null) throw new Error('附件必须位于当前工作区内')
        return { ...attachment, path }
      })
      const content = withAttachments(parsed.data.content, attachments)
      options.onPromptStarted?.()
      const requestId = `dex-prompt-${Date.now()}-${String(++promptSequence)}`
      // 控制桥会话（从磁盘恢复的历史会话）：投递走 `/dex-control` 的 sessions/prompt。
      // 这条通道**不碰 SDK**——`session/prompt` 的 getOrCreateSession 只 create、不
      // resume，喂历史会话必抛 SessionAlreadyExistsError。
      if (active.channel === 'control') {
        if (options.promptViaControl === undefined) {
          return failure('CONTROL_UNSUPPORTED', '当前宿主未提供会话续聊能力', true)
        }
        await options.promptViaControl({ sessionId: active.sessionId, content })
        return success(sessionPromptResultSchema.parse({ requestId, ...noticeField }))
      }
      if (initializedWorkspacePath !== active.workspacePath) {
        await host.request('initialize', {
          cwd: active.workspacePath,
          provider: active.provider,
          model: active.model,
          ...(parsed.data.reasoningEffort === undefined
            ? active.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: active.reasoningEffort }
            : { reasoningEffort: parsed.data.reasoningEffort }),
        })
        initializedWorkspacePath = active.workspacePath
      }
      await host.request('session/prompt', {
        sessionId: active.sessionId,
        contentBlocks: [
          {
            type: 'text',
            text: content,
          },
        ],
      })
      return success(sessionPromptResultSchema.parse({ requestId, ...noticeField }))
    } catch (error) {
      // 只回滚 SDK 的 initialize 记忆：控制桥分支从不设置它，别顺手清掉
      // 「同一个工作区刚 initialize 过」这个事实。
      if (active.channel === 'stdio' && initializedWorkspacePath === active.workspacePath) {
        initializedWorkspacePath = null
      }
      return failed(mapPromptFailure(error, active.sessionId))
    } finally {
      active.busy = false
    }
  })

  ipcMain.handle(stop, async (_event, raw: unknown): Promise<SessionIpcResponse> => {
    const parsed = sessionStopRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('BAD_REQUEST', '停止参数无效')
    // 只有登记在本进程的会话才可能有活跃 Agent；未登记的直接如实拒绝，
    // 避免把「历史会话只读回放」误报成「已停止」。
    if (registry.find(parsed.data.sessionId) === undefined) {
      return failure('SESSION_NOT_ACTIVE', '当前没有这个活跃会话', true)
    }
    if (options.cancelSession === undefined) {
      return failure('CANCEL_UNSUPPORTED', '当前宿主未提供停止能力')
    }
    try {
      await options.cancelSession(parsed.data.sessionId)
    } catch (error) {
      return failed(mapStopFailure(error))
    }
    return success(sessionStopResultSchema.parse({ accepted: true }))
  })

  return () => {
    ipcMain.removeHandler(pick)
    ipcMain.removeHandler(pickFiles)
    ipcMain.removeHandler(create)
    ipcMain.removeHandler(activate)
    ipcMain.removeHandler(prompt)
    ipcMain.removeHandler(stop)
  }
}
