import type { ModelSelection } from '@dexagent/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  type AgentHandleLike,
  type AgentLike,
  type AgentRegistryLike,
  type CreateUserMessageLike,
  createAgentSession,
  type PromptMode,
} from './agent-session'

/** 可观测的假 Agent：记录收到的消息与调用方式。 */
interface FakeAgent extends AgentLike {
  readonly followups: unknown[]
  readonly steers: unknown[]
}

function fakeAgent(): FakeAgent {
  const followups: unknown[] = []
  const steers: unknown[] = []
  return {
    options: { provider: 'rings', model: 'gpt-6-luna' },
    ctx: { on: () => () => {} },
    followup: (message) => {
      followups.push(message)
    },
    steer: (message) => {
      steers.push(message)
    },
    followups,
    steers,
  }
}

/**
 * 假 `ctx.agents`：`resume` 完成后 `get` 才开始返回活体，从而逼出「幂等 / 去重」
 * 这些只有在真实时序下才会暴露的分支。options 原样转交给内层 mock，便于断言
 * agentOptions 的翻译结果。
 */
function registry(input: {
  readonly resume: (options: {
    readonly resumeSessionId: string
    readonly agentOptions?: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }
  }) => Promise<AgentHandleLike>
}): AgentRegistryLike {
  const live = new Map<string, AgentLike>()
  return {
    get: (id) => live.get(id),
    resume: async (options) => {
      const handle = await input.resume(options)
      live.set(options.resumeSessionId, handle.agent)
      return handle
    },
  }
}

const messageFactory: CreateUserMessageLike = () => ({ id: 'msg-1' })

/** 手动放行的 Promise：用来把「resume 还在飞行中」这一刻卡住。 */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(input: {
  readonly agents: AgentRegistryLike
  readonly selection?: ModelSelection
  readonly loadFactory?: () => Promise<CreateUserMessageLike | null>
  readonly installSelection?: (
    sessionId: string,
    agent: AgentLike,
    selection: ModelSelection,
  ) => Promise<void>
}) {
  const install = vi.fn(
    input.installSelection ??
      (async () => {
        /* 默认成功且无副作用 */
      }),
  )
  const session = createAgentSession({
    getAgents: () => input.agents,
    selectionOf: () => input.selection,
    installSelection: install,
    loadUserMessageFactory: input.loadFactory ?? (async () => messageFactory),
  })
  return { session, install }
}

describe('createAgentSession.ensureLive', () => {
  it('已经是活体时直接复用，不再 resume（幂等）', async () => {
    const live = fakeAgent()
    const resume = vi.fn()
    const session = createAgentSession({
      getAgents: () => ({ get: () => live, resume }),
      selectionOf: () => undefined,
      installSelection: async () => {},
      loadUserMessageFactory: async () => messageFactory,
    })

    expect(await session.ensureLive('sess-1', null)).toBe(live)
    expect(resume).not.toHaveBeenCalled()
  })

  it('未活体时 resume 一次，并把选择翻译成 agentOptions', async () => {
    const resumed = fakeAgent()
    const resume = vi.fn(async () => ({ agent: resumed }))
    const { session } = setup({ agents: registry({ resume }) })

    expect(
      await session.ensureLive('sess-1', {
        provider: 'rings',
        model: 'gpt-6-luna',
        reasoningEffort: 'high',
      }),
    ).toBe(resumed)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: 'sess-1',
      agentOptions: { provider: 'rings', model: 'gpt-6-luna', reasoningEffort: 'high' },
    })
  })

  it('没有选择时不传 agentOptions（交给 dsh 的默认模型）', async () => {
    const resume = vi.fn(async () => ({ agent: fakeAgent() }))
    const { session } = setup({ agents: registry({ resume }) })

    await session.ensureLive('sess-1', null)
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: 'sess-1' })
  })

  it('并发同一 id 只 resume 一次（写占用不可重入）', async () => {
    const resumed = fakeAgent()
    const gate = deferred<AgentHandleLike>()
    const resume = vi.fn(() => gate.promise)
    const { session } = setup({ agents: registry({ resume }) })

    const first = session.ensureLive('sess-1', null)
    const second = session.ensureLive('sess-1', null)
    await Promise.resolve()
    expect(resume).toHaveBeenCalledTimes(1)

    gate.resolve({ agent: resumed })
    expect(await first).toBe(resumed)
    expect(await second).toBe(resumed)
  })

  it('宿主未提供 resume 能力时给出人话错误', async () => {
    const { session } = setup({ agents: { get: () => undefined } })

    await expect(session.ensureLive('sess-1', null)).rejects.toThrow('未提供会话恢复能力')
  })

  it('resume 失败时原样冒泡，且不把半成品记进持有表', async () => {
    const resume = vi.fn(async () => {
      throw new Error('agent "sess-1" is already registered')
    })
    const { session } = setup({ agents: registry({ resume }) })

    await expect(session.ensureLive('sess-1', null)).rejects.toThrow('already registered')
    // 失败路径不该产出可释放的 handle
    await expect(session.disposeAll()).resolves.toBeUndefined()
  })

  it('resume 成功后把界面选中的模型装回活体；装失败不影响本次结果', async () => {
    const resumed = fakeAgent()
    const resume = vi.fn(async () => ({ agent: resumed }))
    const failing = setup({
      agents: registry({ resume }),
      selection: { provider: 'rings', model: 'gpt-6-luna' },
      installSelection: async () => {
        throw new Error('agent model-selection context is unavailable')
      },
    })

    await expect(failing.session.ensureLive('sess-1', null)).resolves.toBe(resumed)
    expect(failing.install).toHaveBeenCalledTimes(1)
    expect(failing.install.mock.calls[0]?.[0]).toBe('sess-1')
  })

  it('没有界面选择时不尝试安装', async () => {
    const resume = vi.fn(async () => ({ agent: fakeAgent() }))
    const { session, install } = setup({ agents: registry({ resume }) })

    await session.ensureLive('sess-1', { provider: 'rings', model: 'gpt-6-luna' })
    expect(install).not.toHaveBeenCalled()
  })
})

describe('createAgentSession.deliver', () => {
  it('followup 走 followup，steer 走 steer', async () => {
    const agent = fakeAgent()
    const resume = vi.fn(async () => ({ agent }))
    const { session } = setup({ agents: registry({ resume }) })
    await session.ensureLive('sess-1', null)

    expect(await session.deliver('sess-1', '继续', 'followup')).toEqual({ messageId: 'msg-1' })
    expect(agent.followups).toHaveLength(1)
    expect(agent.steers).toHaveLength(0)

    expect(await session.deliver('sess-1', '打断一下', 'steer')).toEqual({ messageId: 'msg-1' })
    expect(agent.steers).toHaveLength(1)
  })

  it('消息体与 SDK server 同形（text block + user source）', async () => {
    const agent = fakeAgent()
    const resume = vi.fn(async () => ({ agent }))
    const captured: unknown[] = []
    const { session } = setup({
      agents: registry({ resume }),
      loadFactory: async () => (input) => {
        captured.push(input)
        return { id: 'msg-9' }
      },
    })
    await session.ensureLive('sess-1', null)

    expect(await session.deliver('sess-1', '你好', 'followup')).toEqual({ messageId: 'msg-9' })
    expect(captured[0]).toEqual({
      content: [{ type: 'text', text: '你好' }],
      source: { kind: 'user' },
    })
  })

  it('未活体历史会话在 prompt 时先懒恢复，再投递', async () => {
    const agent = fakeAgent()
    const resume = vi.fn(async () => ({ agent }))
    const { session } = setup({ agents: registry({ resume }) })

    await expect(session.deliver('sess-404', '你好', 'followup')).resolves.toEqual({
      messageId: 'msg-1',
    })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: 'sess-404' })
    expect(agent.followups).toHaveLength(1)
  })

  it('并发 prompt 共享同一历史会话的懒恢复', async () => {
    const agent = fakeAgent()
    const gate = deferred<AgentHandleLike>()
    const resume = vi.fn(() => gate.promise)
    const { session } = setup({ agents: registry({ resume }) })

    const first = session.deliver('sess-404', '先一条', 'followup')
    const second = session.deliver('sess-404', '再一条', 'followup')
    await Promise.resolve()
    expect(resume).toHaveBeenCalledTimes(1)
    gate.resolve({ agent })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { messageId: 'msg-1' },
      { messageId: 'msg-1' },
    ])
    expect(agent.followups).toHaveLength(2)
  })

  it('agent 缺对应能力时给出人话错误', async () => {
    const noSteer: AgentLike = { followup: () => {} }
    const { session } = setup({ agents: { get: () => noSteer } })

    await expect(session.deliver('sess-1', 'x', 'steer')).rejects.toThrow('未提供 steer 能力')
  })

  it('模块载入失败与消息缺 id 都是明确的错误', async () => {
    const noModule = setup({
      agents: { get: () => fakeAgent() },
      loadFactory: async () => null,
    })
    await expect(noModule.session.deliver('sess-1', 'x', 'followup')).rejects.toThrow(
      '消息构造能力不可用',
    )

    const noId = setup({
      agents: { get: () => fakeAgent() },
      loadFactory: async () => () => ({}),
    })
    await expect(noId.session.deliver('sess-1', 'x', 'followup')).rejects.toThrow('未返回 id')
  })
})

describe('createAgentSession.disposeAll', () => {
  it('释放全部持有的 handle', async () => {
    const disposed: string[] = []
    const resume = vi.fn(async ({ resumeSessionId }: { readonly resumeSessionId: string }) => ({
      agent: fakeAgent(),
      dispose: async () => {
        disposed.push(resumeSessionId)
      },
    }))
    const { session } = setup({ agents: registry({ resume }) })

    await session.ensureLive('a', null)
    await session.ensureLive('b', null)
    await session.disposeAll()

    expect(disposed.sort()).toEqual(['a', 'b'])
  })

  it('卸载后完成的恢复自我释放，不留下悬挂活体', async () => {
    const dispose = vi.fn(async () => {})
    const resumed = fakeAgent()
    const gate = deferred<AgentHandleLike>()
    const resume = vi.fn(() => gate.promise)
    const { session } = setup({ agents: registry({ resume }) })

    const inflight = session.ensureLive('sess-1', null)
    await Promise.resolve()
    await session.disposeAll()
    gate.resolve({ agent: resumed, dispose })

    await expect(inflight).rejects.toThrow('已卸载')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('释放失败不阻断卸载（agent 侧本就是幂等清理）', async () => {
    const resume = vi.fn(async () => ({
      agent: fakeAgent(),
      dispose: async () => {
        throw new Error('already disposed')
      },
    }))
    const { session } = setup({ agents: registry({ resume }) })

    await session.ensureLive('sess-1', null)
    await expect(session.disposeAll()).resolves.toBeUndefined()
  })
})

// 类型用途：确保 PromptMode 的取值集合不会被无意放宽
const modes: readonly PromptMode[] = ['followup', 'steer']
void modes
