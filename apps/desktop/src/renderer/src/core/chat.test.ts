import { describe, expect, it } from 'vitest'
import { buildChatTimeline, type LocalChatMessage } from './chat'

const local = (id: string, content: string, createdAt: number): LocalChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'completed',
  createdAt,
})

describe('buildChatTimeline', () => {
  it('按 Turn 交错渲染用户与助手，且不会重复本地用户消息', () => {
    const timeline = buildChatTimeline(
      [local('local-1', '第一轮', 1), local('local-2', '第二轮', 10)],
      [
        {
          id: 'session:t1',
          userMessage: '第一轮',
          assistantMessage: '第一轮完成',
          status: 'completed',
          startedAt: 2,
          endedAt: 5,
          steps: [],
        },
        {
          id: 'session:t2',
          userMessage: '第二轮',
          assistantMessage: '第二轮完成',
          status: 'completed',
          startedAt: 11,
          endedAt: 15,
          steps: [],
        },
      ],
      { pending: false, error: null },
    )

    expect(timeline.map((item) => `${item.role}:${item.content}`)).toEqual([
      'user:第一轮',
      'assistant:第一轮完成',
      'user:第二轮',
      'assistant:第二轮完成',
    ])
  })

  it('保留尚未出现 Trace Turn 的本地消息，并把 pending/error 放到末尾', () => {
    const timeline = buildChatTimeline([local('local-1', '等待任务', 1)], [], {
      pending: true,
      error: '执行失败',
      now: 20,
    })

    expect(timeline.map((item) => item.role)).toEqual(['user', 'pending', 'error'])
  })

  it('合成状态行的位置不随渲染时刻漂移（PLAN 问题 ③ 的回归）', () => {
    // 原实现用 `options.now ?? Date.now()` 当排序时间戳，于是每渲染一次 pending 就
    // 「跳」到最新位置——模型回复完之后看起来又回到了「正在执行任务」。
    const turns = [
      {
        id: 'session:t1',
        userMessage: '任务',
        assistantMessage: '回复',
        status: 'completed' as const,
        startedAt: 2,
        endedAt: 5,
        steps: [],
      },
    ]
    const at = (now: number): string[] =>
      buildChatTimeline([local('local-1', '任务', 1)], turns, {
        pending: true,
        error: null,
        now,
      }).map((item) => item.role)

    expect(at(10)).toEqual(['user', 'assistant', 'pending'])
    expect(at(999_999)).toEqual(at(10))
  })

  it('pending 气泡用本轮开始时刻显示，不占用排序键', () => {
    const timeline = buildChatTimeline([local('local-1', '任务', 1)], [], {
      pending: true,
      error: null,
      pendingStartedAt: 42,
      now: 9_999,
    })
    const pending = timeline.find((item) => item.role === 'pending')
    expect(pending?.createdAt).toBe(42)
  })

  it('失败轮次渲染出宿主给出的原因（D03 回归）', () => {
    // 原实现把 `turn/end` 的 `reason.error` 丢掉，失败的轮次在聊天区不留任何痕迹——
    // 用户看到的是「消息发出去了，然后什么都没发生」。
    const timeline = buildChatTimeline(
      [local('local-1', 'pong', 1)],
      [
        {
          id: 'session:t9',
          userMessage: 'pong',
          status: 'failed',
          startedAt: 2,
          endedAt: 8,
          failureCode: 'UNSUPPORTED_REASONING_EFFORT',
          failureMessage: 'provider "deepseek-official" model "deepseek-flash" 不支持 medium',
          steps: [],
        },
      ],
      { pending: false, error: null },
    )

    expect(timeline.map((item) => `${item.role}:${item.content}`)).toEqual([
      'user:pong',
      'error:provider "deepseek-official" model "deepseek-flash" 不支持 medium（UNSUPPORTED_REASONING_EFFORT）',
    ])
  })

  it('没有任何原因的失败轮次不凭空造错误行（用户主动停止等）', () => {
    const timeline = buildChatTimeline(
      [local('local-1', '任务', 1)],
      [
        {
          id: 'session:t1',
          userMessage: '任务',
          status: 'failed',
          startedAt: 2,
          endedAt: 8,
          steps: [],
        },
      ],
      { pending: false, error: null },
    )

    expect(timeline.map((item) => item.role)).toEqual(['user'])
  })
})
