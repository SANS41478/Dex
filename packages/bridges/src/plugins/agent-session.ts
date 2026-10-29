/**
 * 会话恢复与消息投递（D33）：把磁盘上的历史会话变成能收消息的活体，
 * 再往里投递用户消息。
 *
 * 为什么单独一层：`host/model-control-entry.ts` 只该负责路由与信封，而「去重、
 * 卸载释放、交付方式选择」这些最容易出错的路径必须能用假 dsh 完整覆盖。这里因此
 * 只依赖 `ctx.agents` 的最小投影 + 三个注入点（模型选择安装、模块加载、选择查询）。
 *
 * 关键约束（都来自 dsh 侧的真实实现）：
 * - `ctx.agents.resume({ resumeSessionId })` 会拿会话日志的**写占用**，并发调用同一
 *   id 会双双失败 → 去重不是优化而是必需。
 * - 返回的 `AgentHandle` 是**拥有权能力**：持有者有义务 dispose，否则宿主里会留下
 *   没人负责的活体。
 * - `followup` 开新的一轮对话；`steer` 插到当前轮次的下一个 step 边界。
 */
import type { ModelSelection } from '@dexagent/shared'

/** `ctx.agents.get(id)` / `AgentHandle.agent` 的最小投影。 */
export interface AgentLike {
  readonly options?: ModelSelection
  readonly ctx?: unknown
  /** dsh `Agent.followup(message)`：开一轮普通的后续对话并唤醒驱动器。 */
  readonly followup?: (message: unknown) => void
  /** dsh `Agent.steer(message)`：把消息插到当前轮次的下一个 step 边界。 */
  readonly steer?: (message: unknown) => void
}

/** dsh `AgentHandle`：`agents.create` / `agents.resume` 返回的「拥有权 + 释放器」。 */
export interface AgentHandleLike {
  readonly agent: AgentLike
  dispose?: () => Promise<void>
}

export interface AgentOptionsLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
  resume?(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: AgentOptionsLike
  }): Promise<AgentHandleLike>
}

/** `createUserMessage` 的返回值里我们只关心消息 id。 */
export interface UserMessageLike {
  readonly id?: unknown
}

export type CreateUserMessageLike = (input: {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'user' }
}) => UserMessageLike

export type PromptMode = 'followup' | 'steer'

export interface AgentSessionOptions {
  readonly getAgents: () => AgentRegistryLike
  /** 该会话在界面上被选中的模型（`models/select` 的结果）；没有则为 `undefined`。 */
  readonly selectionOf: (sessionId: string) => ModelSelection | undefined
  /**
   * 把选择装进活起来的 agent（会话内再切换模型走这条）。失败只影响后续切换，
   * 本次 resume 的 `agentOptions` 已经生效，所以实现内部应当自行吞掉异常。
   */
  readonly installSelection: (
    sessionId: string,
    agent: AgentLike,
    selection: ModelSelection,
  ) => Promise<void>
  /** 载入 dsh 的消息构造能力；解析不出时返回 `null`（由本模块给出人话错误）。 */
  readonly loadUserMessageFactory: () => Promise<CreateUserMessageLike | null>
}

export interface AgentSession {
  /**
   * 确保该会话在宿主里是活体并返回它的 Agent。
   *
   * 已经是活体 → 直接复用（幂等）；正在恢复 → 复用同一次调用；否则
   * `agents.resume({ resumeSessionId, agentOptions })` 从磁盘载入。
   */
  ensureLive(sessionId: string, selection: ModelSelection | null): Promise<AgentLike>
  /** 往已活起来的会话投递一条消息。 */
  deliver(sessionId: string, content: string, mode: PromptMode): Promise<{ messageId: string }>
  /**
   * 释放全部持有的 handle，并让此后完成的恢复自我释放。
   * 绑在插件 fiber 上（`ctx.effect`）：宿主热重载 / 进程退出时不能留下悬挂活体。
   */
  disposeAll: () => Promise<void>
}

function toAgentOptions(selection: ModelSelection): AgentOptionsLike {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  /** 本层 resume 出来的活体。会话切换**不**释放：重建要重读整份日志。 */
  const handles = new Map<string, AgentHandleLike>()
  /** 同 id 的并发恢复去重。 */
  const pending = new Map<string, Promise<void>>()
  /** 已开始卸载：此后完成的恢复立刻自我释放。 */
  let disposed = false

  const release = async (handle: AgentHandleLike): Promise<void> => {
    try {
      await handle.dispose?.()
    } catch {
      // 释放是幂等清理；fiber 卸载路径上失败也只能忽略。
    }
  }

  const ensureLive = async (
    sessionId: string,
    selection: ModelSelection | null,
  ): Promise<AgentLike> => {
    const agents = options.getAgents()
    const live = agents.get(sessionId)
    if (live !== undefined) return live

    const inFlight = pending.get(sessionId)
    if (inFlight !== undefined) {
      await inFlight
      const resumed = agents.get(sessionId)
      if (resumed === undefined) throw new Error(`会话 ${sessionId} 的恢复未能完成`)
      return resumed
    }

    const resume = agents.resume
    if (typeof resume !== 'function') {
      throw new Error('当前 dsh 宿主未提供会话恢复能力（ctx.agents.resume）')
    }
    const task = (async (): Promise<void> => {
      const handle = await resume.call(agents, {
        resumeSessionId: sessionId,
        ...(selection === null ? {} : { agentOptions: toAgentOptions(selection) }),
      })
      if (disposed) {
        // 恢复在飞行途中撞上卸载：立刻释放，绝不把活体留给宿主。
        await release(handle)
        throw new Error('模型控制通道已卸载，会话恢复被放弃')
      }
      handles.set(sessionId, handle)
      const selected = options.selectionOf(sessionId)
      if (selected !== undefined) {
        try {
          await options.installSelection(sessionId, handle.agent, selected)
        } catch {
          // 装不上只影响「会话内再切换模型」：本次 resume 的 agentOptions 已经生效，
          // 没理由让整次恢复失败。契约由本层保证，不指望每个调用方都记得兜。
        }
      }
    })()
    pending.set(sessionId, task)
    try {
      await task
    } finally {
      pending.delete(sessionId)
    }
    const resumed = agents.get(sessionId)
    if (resumed === undefined) throw new Error(`会话 ${sessionId} 的恢复未能完成`)
    return resumed
  }

  const deliver = async (
    sessionId: string,
    content: string,
    mode: PromptMode,
  ): Promise<{ messageId: string }> => {
    const agent = await ensureLive(sessionId, options.selectionOf(sessionId) ?? null)
    const factory = await options.loadUserMessageFactory()
    if (factory === null) {
      throw new Error('dsh 消息构造能力不可用（@deepseek-ai/dsh-llm 未能载入）')
    }
    const message = factory({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    if (mode === 'steer') {
      if (typeof agent.steer !== 'function') {
        throw new Error('当前 dsh 版本的 Agent 未提供 steer 能力')
      }
      agent.steer(message)
    } else {
      if (typeof agent.followup !== 'function') {
        throw new Error('当前 dsh 版本的 Agent 未提供 followup 能力')
      }
      agent.followup(message)
    }
    if (typeof message.id !== 'string') throw new Error('dsh 消息构造未返回 id')
    return { messageId: message.id }
  }

  const disposeAll = async (): Promise<void> => {
    disposed = true
    const held = [...handles.values()]
    handles.clear()
    for (const handle of held) await release(handle)
  }

  return { ensureLive, deliver, disposeAll }
}
