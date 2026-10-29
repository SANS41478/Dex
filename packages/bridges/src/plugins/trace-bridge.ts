import {
  makeMessage,
  type StepRecord,
  traceStateToMessages as serializeTraceState,
  type ToolCallRecord,
  type TraceMessage,
  type TurnRecord,
} from '@dexagent/shared'
import type { TraceProjectionState } from './trace-fold'

export interface TraceMappingOptions {
  /** 工具名 → 插件条目 id（`createToolOwnerResolver`；未命中为 `unknown`）。 */
  readonly resolvePluginId: (toolName: string) => string
  /** `trace.turn.update` 等桥侧产生消息的时间源（测试注入固定时钟）。 */
  readonly now: () => number
}

function toolToMessages(tool: ToolCallRecord, options: TraceMappingOptions): TraceMessage[] {
  const messages: TraceMessage[] = [
    makeMessage('trace.tool.start', {
      toolCallId: tool.id,
      stepId: tool.stepId,
      toolName: tool.toolName,
      pluginId: options.resolvePluginId(tool.toolName),
      input: tool.input,
      at: tool.startedAt,
    }),
  ]
  if (tool.status !== 'running' && tool.endedAt !== undefined) {
    messages.push(
      makeMessage('trace.tool.end', {
        toolCallId: tool.id,
        stepId: tool.stepId,
        status: tool.status === 'failed' ? 'failed' : 'success',
        ...(tool.output === undefined ? {} : { output: tool.output }),
        ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
        at: tool.endedAt,
      }),
    )
  }
  return messages
}

function stepToMessages(step: StepRecord, options: TraceMappingOptions): TraceMessage[] {
  const messages: TraceMessage[] = [
    makeMessage('trace.step.start', {
      turnId: step.turnId,
      stepId: step.id,
      index: step.index,
      at: step.startedAt,
    }),
  ]
  const reasoningMessage = reasoningToMessage(step)
  if (reasoningMessage !== null) messages.push(reasoningMessage)
  for (const tool of step.toolCalls) messages.push(...toolToMessages(tool, options))
  if (step.status !== 'running' && step.status !== 'pending' && step.endedAt !== undefined) {
    messages.push(
      makeMessage('trace.step.end', {
        stepId: step.id,
        status: step.status === 'failed' ? 'failed' : 'success',
        ...(step.llmReasoning === '' ? {} : { llmReasoning: step.llmReasoning }),
        ...(step.reasoning === undefined || step.reasoning === ''
          ? {}
          : { reasoning: step.reasoning }),
        at: step.endedAt,
      }),
    )
  }
  return messages
}

/** 思考消息（step.end 之前单独下发；无思考返回 null）。 */
function reasoningToMessage(step: StepRecord): TraceMessage | null {
  if (step.reasoning === undefined || step.reasoning === '') return null
  return makeMessage('trace.step.reasoning', {
    stepId: step.id,
    reasoning: step.reasoning,
    at: step.startedAt,
  })
}

function turnToMessages(turn: TurnRecord, options: TraceMappingOptions): TraceMessage[] {
  const messages: TraceMessage[] = [
    makeMessage('trace.turn.start', {
      turnId: turn.id,
      userMessage: turn.userMessage,
      at: turn.startedAt,
    }),
  ]
  for (const step of turn.steps) messages.push(...stepToMessages(step, options))
  if (turn.status !== 'running' && turn.endedAt !== undefined) {
    messages.push(
      makeMessage('trace.turn.end', {
        turnId: turn.id,
        status: turn.status === 'completed' ? 'completed' : 'failed',
        ...(turn.assistantMessage === undefined ? {} : { assistantMessage: turn.assistantMessage }),
        ...(turn.failureCode === undefined ? {} : { failureCode: turn.failureCode }),
        ...(turn.failureMessage === undefined ? {} : { failureMessage: turn.failureMessage }),
        at: turn.endedAt,
      }),
    )
  }
  return messages
}

const byId = <T extends { readonly id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]))

function diffTool(
  previous: ToolCallRecord | undefined,
  next: ToolCallRecord,
  options: TraceMappingOptions,
): TraceMessage[] {
  if (previous === undefined) return toolToMessages(next, options)
  const endedNow = previous.status === 'running' && next.status !== 'running'
  const endMoved = previous.endedAt !== next.endedAt && next.status !== 'running'
  if (!endedNow && !endMoved) return []
  if (next.endedAt === undefined) return []
  return [
    makeMessage('trace.tool.end', {
      toolCallId: next.id,
      stepId: next.stepId,
      status: next.status === 'failed' ? 'failed' : 'success',
      ...(next.output === undefined ? {} : { output: next.output }),
      ...(next.durationMs === undefined ? {} : { durationMs: next.durationMs }),
      at: next.endedAt,
    }),
  ]
}

function diffStep(
  previous: StepRecord | undefined,
  next: StepRecord,
  options: TraceMappingOptions,
): TraceMessage[] {
  if (previous === undefined) return stepToMessages(next, options)

  const messages: TraceMessage[] = []
  // 思考先于工具结果到达（`assistant/message` 在 `tool/call` 之前），故只要文本变化就立刻下发：
  // 用户在工具还在跑的时候就能看到「它在想什么」，不必等整步结束。
  if (previous.reasoning !== next.reasoning) {
    const reasoningMessage = reasoningToMessage(next)
    if (reasoningMessage !== null) messages.push(reasoningMessage)
  }
  const previousTools = byId(previous.toolCalls)
  for (const tool of next.toolCalls) {
    messages.push(...diffTool(previousTools.get(tool.id), tool, options))
  }

  const ended = previous.status !== next.status && next.status !== 'running'
  if (ended && next.endedAt !== undefined) {
    messages.push(
      makeMessage('trace.step.end', {
        stepId: next.id,
        status: next.status === 'failed' ? 'failed' : 'success',
        ...(next.llmReasoning === '' ? {} : { llmReasoning: next.llmReasoning }),
        ...(next.reasoning === undefined || next.reasoning === ''
          ? {}
          : { reasoning: next.reasoning }),
        at: next.endedAt,
      }),
    )
  }
  return messages
}

function diffTurn(
  previous: TurnRecord | undefined,
  next: TurnRecord,
  options: TraceMappingOptions,
): TraceMessage[] {
  if (previous === undefined) return turnToMessages(next, options)

  const messages: TraceMessage[] = []
  if (previous.userMessage !== next.userMessage && next.userMessage !== '') {
    messages.push(
      makeMessage('trace.turn.update', {
        turnId: next.id,
        userMessage: next.userMessage,
        at: options.now(),
      }),
    )
  }

  const previousSteps = byId(previous.steps)
  for (const step of next.steps) {
    messages.push(...diffStep(previousSteps.get(step.id), step, options))
  }

  const assistantChanged =
    previous.assistantMessage !== next.assistantMessage && next.assistantMessage !== undefined
  const statusChanged = previous.status !== next.status
  const failureChanged =
    previous.failureCode !== next.failureCode || previous.failureMessage !== next.failureMessage
  if (
    (statusChanged || assistantChanged || failureChanged) &&
    next.status !== 'running' &&
    next.endedAt !== undefined
  ) {
    messages.push(
      makeMessage('trace.turn.end', {
        turnId: next.id,
        status: next.status === 'completed' ? 'completed' : 'failed',
        ...(next.assistantMessage === undefined ? {} : { assistantMessage: next.assistantMessage }),
        ...(next.failureCode === undefined ? {} : { failureCode: next.failureCode }),
        ...(next.failureMessage === undefined ? {} : { failureMessage: next.failureMessage }),
        at: next.endedAt,
      }),
    )
  }
  return messages
}

/** 全量回放：把一份投影状态翻译成按序六类事件（连接建立 / 断线重连用，渲染端 fold 幂等）。 */
export function traceStateToMessages(
  state: TraceProjectionState,
  options: TraceMappingOptions,
): TraceMessage[] {
  return serializeTraceState(state, { resolvePluginId: options.resolvePluginId })
}

/**
 * 增量映射：投影前后状态 → 需要下发的协议消息。
 * `previous` 为空（首次观测）等价于全量回放；同一引用返回空数组（fold 契约：无关事件保持同引用）。
 */
export function diffTraceMessages(
  previous: TraceProjectionState | null | undefined,
  next: TraceProjectionState,
  options: TraceMappingOptions,
): TraceMessage[] {
  if (previous === undefined || previous === null) return traceStateToMessages(next, options)
  if (previous === next) return []

  const messages: TraceMessage[] = []
  const previousTurns = byId(previous.turns)
  for (const turn of next.turns) {
    messages.push(...diffTurn(previousTurns.get(turn.id), turn, options))
  }
  const previousPolicyIds = new Set(previous.policyChanges.map((change) => change.changeId))
  for (const change of next.policyChanges) {
    if (previousPolicyIds.has(change.changeId)) continue
    messages.push(makeMessage('trace.policy', change))
  }
  const previousApprovalIds = new Set(
    previous.approvals.map((approval) => `${approval.requestId}:${approval.phase}`),
  )
  for (const approval of next.approvals) {
    if (previousApprovalIds.has(`${approval.requestId}:${approval.phase}`)) continue
    messages.push(makeMessage('trace.approval', approval))
  }
  return messages
}

export interface TraceBridgeOptions extends TraceMappingOptions {
  /** 协议消息出口：host 接到 `/dex-trace` 广播。 */
  readonly sink: (message: TraceMessage) => void
}

export interface TraceBridge {
  /** 增量：投影变更（`onChanged`）→ diff → sink；首次观测自动全量。 */
  readonly feed: (state: TraceProjectionState) => void
  /** 全量回放消息（新连接只发给该连接；不改变增量基线）。 */
  readonly messagesFor: (state: TraceProjectionState) => TraceMessage[]
  /** 最近一次观测到的会话状态。 */
  readonly current: (sessionId: string) => TraceProjectionState | undefined
  readonly sessions: () => readonly string[]
}

/** trace 桥：维护每会话 last-sent 状态，做增量 diff；回放只按需产出消息。 */
export function createTraceBridge(options: TraceBridgeOptions): TraceBridge {
  const lastBySession = new Map<string, TraceProjectionState>()

  return {
    feed(state) {
      const messages = diffTraceMessages(lastBySession.get(state.sessionId), state, options)
      lastBySession.set(state.sessionId, state)
      for (const message of messages) options.sink(message)
    },
    messagesFor(state) {
      return traceStateToMessages(state, options)
    },
    current: (sessionId) => lastBySession.get(sessionId),
    sessions: () => [...lastBySession.keys()],
  }
}
