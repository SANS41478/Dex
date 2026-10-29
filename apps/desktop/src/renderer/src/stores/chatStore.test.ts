import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from './chatStore'
import { useHostStore } from './hostStore'
import { useModelStore } from './modelStore'
import { useSessionStatusStore } from './sessionStatusStore'
import { useSessionStore } from './sessionStore'
import { useWorkspaceStore } from './workspaceStore'

/**
 * `sending` 的归位是本轮修复的核心（PLAN 问题 ③）：
 * 它是宿主 `session.status` 的投影，不是本地事实。原先只在 `send` 的 catch 分支清零，
 * 成功路径永不清零，界面从第一条消息起就卡在「正在执行任务」。
 */

let stopCalls: string[] = []
let promptFailure: string | null = null
let promptNotice: string | null = null
let pickCalls = 0
let pickResult: { canceled: boolean; path?: string } = { canceled: true }
let createCalls: Array<{ workspacePath: string; selection?: unknown }> = []
let activateCalls: string[] = []
let listSessions: unknown[] = []

function installWindow(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    dex: {
      session: {
        prompt: async (): Promise<unknown> => {
          if (promptFailure !== null) throw new Error(promptFailure)
          return promptNotice === null
            ? { requestId: 'req-1' }
            : { requestId: 'req-1', notice: promptNotice }
        },
        stop: async (sessionId: string): Promise<unknown> => {
          stopCalls.push(sessionId)
          return { accepted: true }
        },
        create: async (input: { workspacePath: string }): Promise<unknown> => {
          createCalls.push(input)
          return { sessionId: `created-${createCalls.length}`, workspacePath: input.workspacePath }
        },
        activate: async (input: { sessionId: string; workspacePath: string }): Promise<unknown> => {
          activateCalls.push(input.sessionId)
          return { sessionId: input.sessionId, workspacePath: input.workspacePath }
        },
      },
      sessions: {
        list: async (): Promise<unknown> => ({ sessions: listSessions }),
      },
      models: {
        list: async (): Promise<unknown> => {
          throw new Error('模型目录不可用（测试桩）')
        },
      },
      workspace: {
        pick: async (): Promise<unknown> => {
          pickCalls += 1
          return pickResult
        },
      },
    },
  }
}

function resetStores(): void {
  useChatStore.setState({
    activeSessionId: 'sess-1',
    workspaceId: 'workspace:e:/ws',
    workspacePath: 'E:/ws',
    messages: [],
    sending: false,
    sendingSince: null,
    stopping: false,
    error: null,
    attachments: [],
  })
  useSessionStatusStore.getState().reset()
  useHostStore.setState({ phase: 'unknown', detail: null, updatedAt: 0 })
}

const apply = (status: 'idle' | 'running', sessionId = 'sess-1'): void => {
  useSessionStatusStore.getState().apply({ sessionId, status })
}

beforeEach(() => {
  stopCalls = []
  promptFailure = null
  promptNotice = null
  pickCalls = 0
  pickResult = { canceled: true }
  createCalls = []
  activateCalls = []
  listSessions = []
  installWindow()
  resetStores()
  useWorkspaceStore.setState({
    workspaces: [{ id: 'workspace:e:/ws', path: 'e:/ws', name: 'ws', lastUsedAt: 1 }],
    sessionWorkspace: {},
    activeWorkspaceId: null,
  })
  useSessionStore.setState({
    sessions: [],
    index: { pinned: [], hidden: [] },
    selectedId: null,
    loading: false,
    error: null,
  })
  useModelStore.setState({
    catalog: { providers: [], configurable: [], selection: null, defaultSelection: null },
    loadState: 'idle',
    error: null,
  })
})

describe('chatStore.send / sending', () => {
  it('成功路径只做乐观置位，sending 归零由宿主 idle 完成', async () => {
    await useChatStore.getState().send('你好')

    expect(useChatStore.getState().sending).toBe(true)
    expect(useChatStore.getState().sendingSince).not.toBeNull()
    expect(useChatStore.getState().messages).toHaveLength(1)

    apply('running')
    expect(useChatStore.getState().sending).toBe(true)

    apply('idle')
    expect(useChatStore.getState().sending).toBe(false)
    expect(useChatStore.getState().sendingSince).toBeNull()
    expect(useChatStore.getState().stopping).toBe(false)
  })

  it('重连基线里的 idle 不误清刚提交的请求（只认 running → idle 跃迁）', async () => {
    await useChatStore.getState().send('你好')

    // main 在 WS 重连时会重放每个会话的最新状态；此时中间没有 running，
    // 若按「看到 idle 就清零」处理，会把还没开始跑的请求当成已结束。
    apply('idle')

    expect(useChatStore.getState().sending).toBe(true)
  })

  it('别的会话变成 idle 不影响当前会话', async () => {
    await useChatStore.getState().send('你好')
    apply('running')

    apply('idle', 'sess-other')

    expect(useChatStore.getState().sending).toBe(true)
  })

  it('发送失败时清零并把原因交给 error（不再重复追加 system 气泡）', async () => {
    promptFailure = '未配置凭据'

    await useChatStore.getState().send('你好')

    const state = useChatStore.getState()
    expect(state.sending).toBe(false)
    expect(state.error).toBe('未配置凭据')
    // 只留用户那条乐观回显：同一句错误过去会在消息流里出现两次
    // （这里的 system 气泡 + `core/chat.ts` 合成的 error 行），见黑盒报告 D05。
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.id.startsWith('local-')).toBe(true)
  })

  it('宿主降级执行时把说明写进消息流（降级但不静默）', async () => {
    promptNotice = '当前 runtime 不支持「read-only」权限，已按「workspace-write」执行'

    await useChatStore.getState().send('你好')

    const state = useChatStore.getState()
    const notice = state.messages.at(-1)
    expect(notice?.role).toBe('system')
    expect(notice?.content).toContain('workspace-write')
    // 它不是失败：不应该点亮行内错误、也不应该给出「重发」。
    expect(state.error).toBeNull()
    expect(state.failedPrompt).toBeNull()
  })
})

describe('chatStore.stop', () => {
  it('请求停止但不提前解锁，等宿主回到 idle', async () => {
    await useChatStore.getState().send('你好')
    apply('running')

    await useChatStore.getState().stop()

    expect(stopCalls).toEqual(['sess-1'])
    expect(useChatStore.getState().stopping).toBe(true)
    // 提前解锁会让用户可以再发一条，撞上 SESSION_BUSY。
    expect(useChatStore.getState().sending).toBe(true)

    apply('idle')
    const state = useChatStore.getState()
    expect(state.sending).toBe(false)
    expect(state.stopping).toBe(false)
  })

  it('未在执行 / 已在停止中时不重复发请求', async () => {
    await useChatStore.getState().stop()
    expect(stopCalls).toEqual([])

    await useChatStore.getState().send('你好')
    apply('running')
    await useChatStore.getState().stop()
    await useChatStore.getState().stop()
    expect(stopCalls).toEqual(['sess-1'])
  })
})

describe('chatStore 兜底', () => {
  it('宿主进入终态时清零（覆盖宿主崩溃导致通知永远到不了的场景）', async () => {
    await useChatStore.getState().send('你好')

    useHostStore.getState().setStatus({ phase: 'error', detail: 'dsh 退出（code=1）' })

    expect(useChatStore.getState().sending).toBe(false)
    expect(useChatStore.getState().sendingSince).toBeNull()
  })
})

/** 非空白当前会话的最小 fixture：让 newSession 不走「当前就是 blank」的早退。 */
const userMessage = {
  id: 'm-1',
  role: 'user' as const,
  content: 'hi',
  status: 'completed' as const,
  createdAt: 1,
}

describe('chatStore.newSession（工作区显式绑定）', () => {
  const other = { id: 'workspace:e:/other', path: 'e:/other', name: 'other', lastUsedAt: 9 }

  it('显式工作区优先于当前会话，并且不再弹目录框', async () => {
    useChatStore.setState({ messages: [userMessage] })
    useWorkspaceStore.setState({
      workspaces: [other],
      sessionWorkspace: {},
      activeWorkspaceId: null,
    })

    await useChatStore.getState().newSession(other)

    expect(pickCalls).toBe(0)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.workspacePath).toBe('e:/other')
    expect(useChatStore.getState().activeSessionId).toBe('created-1')
    expect(useChatStore.getState().workspaceId).toBe('workspace:e:/other')
  })

  it('省略目标时沿用当前会话所属工作区', async () => {
    useChatStore.setState({ messages: [userMessage] })

    await useChatStore.getState().newSession()

    expect(pickCalls).toBe(0)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.workspacePath).toBe('e:/ws')
  })

  it('没有任何可继承工作区时抛 NO_WORKSPACE，绝不隐式建会话', async () => {
    useChatStore.setState({
      activeSessionId: null,
      workspaceId: null,
      workspacePath: null,
      messages: [],
    })
    useWorkspaceStore.setState({ workspaces: [], sessionWorkspace: {}, activeWorkspaceId: null })

    await expect(useChatStore.getState().newSession()).rejects.toMatchObject({
      code: 'NO_WORKSPACE',
    })
    expect(pickCalls).toBe(0)
    expect(createCalls).toHaveLength(0)
  })

  it('当前就是同工作区的空白会话时直接复用，不铸新 id', async () => {
    useChatStore.setState({
      activeSessionId: 'blank-current',
      workspaceId: 'workspace:e:/ws',
      workspacePath: 'E:/ws',
      messages: [],
    })

    await useChatStore.getState().newSession()

    expect(createCalls).toHaveLength(0)
    expect(useChatStore.getState().activeSessionId).toBe('blank-current')
  })

  it('同工作区已有空白会话时复用，不再铸新 id', async () => {
    useChatStore.setState({ messages: [userMessage] })
    listSessions = [
      {
        sessionId: 'blank-1',
        title: '新会话',
        status: 'unknown',
        taskCount: 0,
        blank: true,
        cwd: 'E:/ws',
      },
    ]

    await useChatStore.getState().newSession()

    expect(createCalls).toHaveLength(0)
    expect(activateCalls).toEqual(['blank-1'])
    expect(useChatStore.getState().activeSessionId).toBe('blank-1')
  })

  it('无当前会话时按激活工作区 / 最近工作区继承，不弹框', async () => {
    useChatStore.setState({
      activeSessionId: null,
      workspaceId: null,
      workspacePath: null,
      messages: [],
    })
    useWorkspaceStore.setState({
      workspaces: [
        { id: 'workspace:e:/recent', path: 'e:/recent', name: 'recent', lastUsedAt: 5 },
        { id: 'workspace:e:/old', path: 'e:/old', name: 'old', lastUsedAt: 1 },
      ],
      sessionWorkspace: {},
      activeWorkspaceId: null,
    })

    await useChatStore.getState().newSession()

    expect(pickCalls).toBe(0)
    expect(createCalls[0]?.workspacePath).toBe('e:/recent')
  })
})

describe('chatStore.clear', () => {
  it('forgetBlank 不把被删除的空白会话留在复用池', () => {
    useChatStore.setState({
      activeSessionId: 'blank-deleted',
      workspaceId: 'workspace:e:/ws',
      workspacePath: 'E:/ws',
      messages: [],
    })

    useChatStore.getState().clear({ forgetBlank: true })

    expect(useChatStore.getState().blankSessions.map((item) => item.sessionId)).not.toContain(
      'blank-deleted',
    )
    expect(useChatStore.getState().activeSessionId).toBeNull()
  })
})
