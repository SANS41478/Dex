import { makeMessage, type TraceMessage } from './protocol'
import type {
  ApprovalRecord,
  PolicyChange,
  StepRecord,
  ToolCallRecord,
  TraceState,
  TurnRecord,
} from './trace'

export interface TraceStepCut {
  readonly state: TraceState
  readonly stepId: string
  readonly stepIndex: number
  readonly stepCount: number
}

export type TraceStepCutResult =
  | ({ readonly ok: true } & TraceStepCut)
  | { readonly ok: false; readonly error: string }

function withStep(
  state: TraceState,
  stepId: string,
  update: (step: StepRecord) => StepRecord,
): TraceState {
  let changed = false
  const turns = state.turns.map((turn) => {
    if (!turn.steps.some((step) => step.id === stepId)) return turn
    changed = true
    return {
      ...turn,
      steps: turn.steps.map((step) => (step.id === stepId ? update(step) : step)),
    }
  })
  return changed ? { ...state, turns } : state
}

export function applyTraceMessage(state: TraceState, message: TraceMessage): TraceState {
  switch (message.type) {
    case 'trace.turn.start': {
      const { turnId, userMessage, at } = message.payload
      if (state.turns.some((turn) => turn.id === turnId)) return state
      const turn: TurnRecord = {
        id: turnId,
        userMessage,
        status: 'running',
        startedAt: at,
        steps: [],
      }
      return { ...state, turns: [...state.turns, turn] }
    }
    case 'trace.turn.update': {
      const { turnId, userMessage } = message.payload
      let changed = false
      const turns = state.turns.map((turn) => {
        if (turn.id !== turnId || turn.userMessage === userMessage) return turn
        changed = true
        return { ...turn, userMessage }
      })
      return changed ? { ...state, turns } : state
    }
    case 'trace.step.start': {
      const { turnId, stepId, index, at } = message.payload
      const turn = state.turns.find((item) => item.id === turnId)
      if (!turn || turn.steps.some((step) => step.id === stepId)) return state
      const step: StepRecord = {
        id: stepId,
        turnId,
        index,
        llmReasoning: '',
        status: 'running',
        startedAt: at,
        toolCalls: [],
      }
      return {
        ...state,
        activeStepId: stepId,
        turns: state.turns.map((item) =>
          item.id === turnId ? { ...item, steps: [...item.steps, step] } : item,
        ),
      }
    }
    case 'trace.tool.start': {
      const { stepId, toolCallId, toolName, pluginId, input, at } = message.payload
      return withStep(state, stepId, (step) => {
        if (step.toolCalls.some((toolCall) => toolCall.id === toolCallId)) return step
        const toolCall: ToolCallRecord = {
          id: toolCallId,
          stepId,
          toolName,
          pluginId,
          input,
          status: 'running',
          startedAt: at,
        }
        return { ...step, toolCalls: [...step.toolCalls, toolCall] }
      })
    }
    case 'trace.tool.end': {
      const { stepId, toolCallId, status, output, durationMs, at } = message.payload
      return withStep(state, stepId, (step) => {
        let changed = false
        const toolCalls = step.toolCalls.map((toolCall) => {
          if (toolCall.id !== toolCallId) return toolCall
          changed = true
          const updated: ToolCallRecord = { ...toolCall, status, endedAt: at }
          if (output !== undefined) updated.output = output
          if (durationMs !== undefined) updated.durationMs = durationMs
          return updated
        })
        return changed ? { ...step, toolCalls } : step
      })
    }
    case 'trace.step.reasoning': {
      const { stepId, reasoning } = message.payload
      return withStep(state, stepId, (step) =>
        step.reasoning === reasoning ? step : { ...step, reasoning },
      )
    }
    case 'trace.step.end': {
      const { stepId, status, llmReasoning, reasoning, at } = message.payload
      const next = withStep(state, stepId, (step) => {
        const updated: StepRecord = { ...step, status, endedAt: at }
        if (llmReasoning !== undefined) updated.llmReasoning = llmReasoning
        if (reasoning !== undefined) updated.reasoning = reasoning
        return updated
      })
      if (next === state) return state
      return { ...next, activeStepId: next.activeStepId === stepId ? null : next.activeStepId }
    }
    case 'trace.turn.end': {
      const { turnId, status, assistantMessage, failureCode, failureMessage, at } = message.payload
      let changed = false
      const turns = state.turns.map((turn) => {
        if (turn.id !== turnId) return turn
        if (
          turn.status === status &&
          turn.endedAt === at &&
          turn.assistantMessage === assistantMessage &&
          turn.failureCode === failureCode &&
          turn.failureMessage === failureMessage
        ) {
          return turn
        }
        changed = true
        return {
          ...turn,
          status,
          endedAt: at,
          ...(assistantMessage === undefined ? {} : { assistantMessage }),
          ...(failureCode === undefined ? {} : { failureCode }),
          ...(failureMessage === undefined ? {} : { failureMessage }),
        }
      })
      return changed ? { ...state, turns } : state
    }
    case 'trace.policy': {
      const change: PolicyChange = message.payload
      if (state.policyChanges.some((item) => item.changeId === change.changeId)) return state
      return { ...state, policyChanges: [...state.policyChanges, change] }
    }
    case 'trace.approval': {
      const record: ApprovalRecord = message.payload
      const duplicate = state.approvals.some(
        (item) => item.requestId === record.requestId && item.phase === record.phase,
      )
      if (duplicate) return state
      return { ...state, approvals: [...state.approvals, record] }
    }
  }
}

export interface TraceReplayOptions {
  readonly resolvePluginId?: (toolName: string, pluginId: string) => string
}

function toolToMessages(tool: ToolCallRecord, options: TraceReplayOptions): TraceMessage[] {
  const pluginId = options.resolvePluginId?.(tool.toolName, tool.pluginId) ?? tool.pluginId
  const messages: TraceMessage[] = [
    makeMessage('trace.tool.start', {
      toolCallId: tool.id,
      stepId: tool.stepId,
      toolName: tool.toolName,
      pluginId,
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

function stepBoundaryAt(step: StepRecord): number {
  let boundary = step.startedAt
  if (step.endedAt !== undefined) boundary = Math.max(boundary, step.endedAt)
  for (const tool of step.toolCalls) {
    boundary = Math.max(boundary, tool.startedAt)
    if (tool.endedAt !== undefined) boundary = Math.max(boundary, tool.endedAt)
  }
  return boundary
}

/**
 * 截断到某个 Step 的历史状态。
 *
 * 目标 Step 自身保留，后续 Step/Tool Call 丢弃；策略与审批按目标 Step
 * 的最后已知时间截断。目标不是该 Turn 的最后一步时，Turn 保持 running，
 * 表示回看的时间点尚未走到 Turn 结束。
 */
export function truncateTraceStateAtStep(state: TraceState, stepId: string): TraceStepCutResult {
  let targetTurnIndex = -1
  let targetStepIndex = -1
  let targetStep: StepRecord | undefined

  for (const [turnIndex, turn] of state.turns.entries()) {
    const stepIndex = turn.steps.findIndex((step) => step.id === stepId)
    if (stepIndex === -1) continue
    targetTurnIndex = turnIndex
    targetStepIndex = stepIndex
    targetStep = turn.steps[stepIndex]
    break
  }

  if (targetTurnIndex === -1 || targetStep === undefined) {
    return { ok: false, error: `找不到 Step：${stepId}` }
  }

  const targetTurn = state.turns[targetTurnIndex]
  if (targetTurn === undefined) {
    return { ok: false, error: `找不到 Step 所属 Turn：${stepId}` }
  }

  const turns = state.turns.slice(0, targetTurnIndex + 1).map((turn, turnIndex) => {
    if (turnIndex < targetTurnIndex) return turn
    const steps = turn.steps.slice(0, targetStepIndex + 1)
    const isFinalCompletedTurn =
      targetStepIndex === turn.steps.length - 1 &&
      targetStep.status !== 'running' &&
      targetStep.status !== 'pending' &&
      turn.endedAt !== undefined
    if (isFinalCompletedTurn) return { ...turn, steps }
    const next = { ...turn, steps, status: 'running' as const }
    delete next.endedAt
    return next
  })

  const boundaryAt = stepBoundaryAt(targetStep)
  const policyChanges = state.policyChanges.filter((change) => change.at <= boundaryAt)
  const approvals = state.approvals.filter((approval) => approval.at <= boundaryAt)
  const visibleTargetTurn = turns.at(-1)
  const visibleTargetStep = visibleTargetTurn?.steps.at(-1)
  const activeStepId = visibleTargetStep?.status === 'running' ? visibleTargetStep.id : null

  return {
    ok: true,
    state: {
      ...state,
      turns,
      activeStepId,
      policyChanges,
      approvals,
    },
    stepId,
    stepIndex: targetStepIndex,
    stepCount: targetTurn.steps.length,
  }
}

function stepToMessages(step: StepRecord, options: TraceReplayOptions): TraceMessage[] {
  const messages: TraceMessage[] = [
    makeMessage('trace.step.start', {
      turnId: step.turnId,
      stepId: step.id,
      index: step.index,
      at: step.startedAt,
    }),
  ]
  // 思考在 tools 之前：与直播顺序一致（`assistant/message` 先于 `tool/call` 到达）。
  if (step.reasoning !== undefined && step.reasoning !== '') {
    messages.push(
      makeMessage('trace.step.reasoning', {
        stepId: step.id,
        reasoning: step.reasoning,
        at: step.startedAt,
      }),
    )
  }
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

function turnToMessages(turn: TurnRecord, options: TraceReplayOptions): TraceMessage[] {
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
        at: turn.endedAt,
      }),
    )
  }
  return messages
}

/** 把完整 trace 状态按 turn → step → tool 顺序编码为既有协议消息。 */
export function traceStateToMessages(
  state: TraceState,
  options: TraceReplayOptions = {},
): TraceMessage[] {
  const messages: TraceMessage[] = []
  for (const turn of state.turns) messages.push(...turnToMessages(turn, options))
  for (const change of state.policyChanges) {
    messages.push(makeMessage('trace.policy', change))
  }
  for (const approval of state.approvals) {
    messages.push(makeMessage('trace.approval', approval))
  }
  return messages
}
