import { useEffect, useMemo, useRef, useState } from 'react'
import { buildChatTimeline } from '../../core/chat'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTraceStore } from '../../stores/traceStore'
import { addWorkspaceAndCreateSession } from '../../stores/workspaceActions'
import { useWorkspaceStore } from '../../stores/workspaceStore'

/** 距底部多少像素内算「仍贴底」：留一点余量，避免小数像素让跟随状态反复抖动。 */
const FOLLOW_THRESHOLD_PX = 24

function turnIdOfMessage(id: string): string | null {
  const marker = id.lastIndexOf(':assistant')
  return marker === -1 ? null : id.slice(0, marker)
}

export function ConversationView() {
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const messages = useChatStore((state) => state.messages)
  const sending = useChatStore((state) => state.sending)
  const sendingSince = useChatStore((state) => state.sendingSince)
  const error = useChatStore((state) => state.error)
  const workspaceId = useChatStore((state) => state.workspaceId)
  const workspacePath = useChatStore((state) => state.workspacePath)
  const newSession = useChatStore((state) => state.newSession)
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const turns = useTraceStore((state) => state.turns)
  const viewMode = useTraceStore((state) => state.viewMode)
  const timeTravelStepId = useTraceStore((state) => state.timeTravelStepId)
  const sessionTurns = useMemo(
    () =>
      activeSessionId === null
        ? turns
        : turns.filter((turn) => turn.id.startsWith(`${activeSessionId}:`)),
    [activeSessionId, turns],
  )
  const timeline = useMemo(
    () =>
      buildChatTimeline(messages, sessionTurns, {
        pending: sending,
        error,
        pendingStartedAt: sendingSince ?? undefined,
      }),
    [messages, sessionTurns, sending, error, sendingSince],
  )
  const turnById = useMemo(
    () => new Map(sessionTurns.map((turn) => [turn.id, turn])),
    [sessionTurns],
  )

  /*
   * 滚动归属（对齐 dsh 的 scroll ownership）：
   * - 只有「读者本来就在底部」时才随新内容自动贴底；
   * - 读者一旦上滚，就不再抢他的滚动位置；
   * - 自己发消息（或切会话）时强制恢复贴底意图。
   * 原实现完全没有滚动逻辑，新消息到达后视图纹丝不动。
   */
  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    // 切换会话时回到「贴底」意图：新会话的起点应该在最新一条。
    if (activeSessionId === null) return
    setFollowing(true)
  }, [activeSessionId])

  useEffect(() => {
    if (sending) setFollowing(true)
  }, [sending])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || !following || timeline.length === 0) return
    element.scrollTop = element.scrollHeight
  }, [timeline, following])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (element === null) return
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    setFollowing(distanceToBottom <= FOLLOW_THRESHOLD_PX)
  }

  /*
   * 空态（dsh 的 EmptyHero，`DefaultConversationViews.tsx:34`）：**blank 会话期间也渲染**，
   * 而不是只给「没有会话」看。UI-08 之后「新对话」立即建出 blank（有 id、无消息），
   * 若只在 `activeSessionId === null` 时渲染，新建会话的聊天区就是一块纯空白——
   * 标志与引导句全部消失。
   *
   * `historyLoading` 门是为了避免切历史会话时闪一下 hero：replay 期间 trace 已被清、
   * 消息还没到，此时应保持安静而不是先亮引导。
   */
  const historyLoading = useSessionStore((state) => state.loading)
  if (timeline.length === 0 && !historyLoading) {
    const hasWorkspace = workspaceId !== null || workspacePath !== null
    return (
      <div className="conversation-empty" data-testid="conversation-empty">
        <span className="conversation-empty-logo" aria-hidden="true" />
        <strong>
          {activeSessionId === null
            ? hasWorkspace
              ? '在当前工作区开始新会话'
              : '先添加一个工作区'
            : '描述你想完成的任务'}
        </strong>
        <span className="muted">
          {activeSessionId === null
            ? hasWorkspace
              ? '每个会话都必须属于一个工作区；右侧会同步展示执行流与图谱。'
              : '会话必须绑定工作区。添加一个目录后即可开始。'
            : '向 Dex 描述你想完成的任务，右侧会同步展示执行流与图谱。'}
        </span>
        {activeSessionId === null ? (
          <button
            type="button"
            className="graph-chip graph-chip-active"
            data-testid="conversation-empty-cta"
            onClick={() => {
              if (workspace !== undefined) {
                void newSession(workspace).catch(() => undefined)
                return
              }
              void addWorkspaceAndCreateSession().catch(() => undefined)
            }}
          >
            {hasWorkspace ? '新建会话' : '添加工作区'}
          </button>
        ) : null}
      </div>
    )
  }

  let previousDate = ''
  return (
    <div
      className="conversation-view"
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="conversation-view"
    >
      {timeline.map((message) => {
        const day = new Date(message.createdAt).toLocaleDateString('zh-CN', {
          month: 'long',
          day: 'numeric',
        })
        const separator = day !== previousDate
        previousDate = day
        const turnId = turnIdOfMessage(message.id)
        const turn = turnId === null ? null : turnById.get(turnId)
        return (
          <div key={message.id}>
            {separator ? <div className="date-separator">{day}</div> : null}
            <article className={`conversation-message conversation-message-${message.role}`}>
              <div className="conversation-message-body">
                <div className="conversation-message-meta">
                  <strong>
                    {message.role === 'user'
                      ? '你'
                      : message.role === 'assistant' || message.role === 'pending'
                        ? 'Dex'
                        : '系统'}
                  </strong>
                  <span>
                    {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="conversation-message-content">{message.content}</p>
                {turn !== undefined && turn !== null && message.role === 'assistant' ? (
                  <div className="conversation-tools">
                    {turn.steps
                      .flatMap((step) => step.toolCalls)
                      .map((tool) => (
                        <details className="tool-card" key={tool.id}>
                          <summary>
                            <span
                              className={`dot dot-${tool.status === 'failed' ? 'failed' : tool.status === 'running' ? 'running' : 'success'}`}
                            />
                            <span className="mono">{tool.toolName}</span>
                            <span className="muted">{tool.status}</span>
                            {tool.durationMs !== undefined ? (
                              <span className="muted">{tool.durationMs}ms</span>
                            ) : null}
                          </summary>
                          <div className="tool-card-body">
                            <pre>{JSON.stringify(tool.input, null, 2)}</pre>
                            {tool.output !== undefined ? <pre>{String(tool.output)}</pre> : null}
                          </div>
                        </details>
                      ))}
                    {turn.status !== 'running' ? (
                      <span className={`conversation-status conversation-status-${turn.status}`}>
                        {turn.status === 'completed' ? '已完成' : '执行失败'}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </article>
          </div>
        )
      })}
      {viewMode === 'replay' || timeTravelStepId !== null ? (
        <div className="readonly-banner">只读回放中</div>
      ) : null}
    </div>
  )
}
