import {
  type ApprovalRecord,
  type PolicyChange,
  type StepRecord,
  type ToolCallRecord,
  type TraceState,
  type TurnRecord,
  traceStateSchema,
} from '@dexagent/shared'
import { z } from 'zod'
import type { SessionEventLike } from '../dsh/session'

/**
 * 投影状态 = renderer 的 trace 记录 + 会话归属（id 派生要 sessionId）。
 * M2-03 映射到协议时把 `sessionId` 剥离即可。
 */
export interface TraceProjectionState extends TraceState {
  readonly sessionId: string
}

export const traceProjectionStateSchema = traceStateSchema.extend({
  sessionId: z.string().min(1),
})

export function createInitialProjectionState(sessionId: string): TraceProjectionState {
  return { sessionId, turns: [], activeStepId: null, policyChanges: [], approvals: [] }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 按内容块取文本。
 *
 * dsh 的 `assistant/message.content` 是块数组，真实形态为
 * `[{type:'reasoning',text},{type:'text',text},{type:'tool-call',…}]`：
 * - `reasoning` = 模型思考（可能数千字）；
 * - `text` = 模型可见输出（回答/旁白）。
 *
 * 旧实现不区分类型、把所有 `text` 拼成一坨塞进 `llmReasoning`，于是时间线与执行流
 * 上那一行「推理摘要」其实是思考+回答的混合体，被单行省略号截成碎片。现在分开取。
 * `type` 缺省的块按可见输出处理（历史/兼容形态）。
 */
function textOfType(message: unknown, wanted: 'reasoning' | 'text'): string {
  const record = asRecord(message)
  const content = record?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const item = asRecord(block)
    // 注意：`asString` 对缺省 `type` 返回 null（不是 undefined），必须判 null。
    const type = asString(item?.type)
    const isWanted =
      wanted === 'reasoning' ? type === 'reasoning' : type === null || type === 'text'
    if (!isWanted) continue
    const text = asString(item?.text)
    if (text !== null) parts.push(text)
  }
  return parts.join('\n')
}

/** 模型思考原文（`type:'reasoning'` 块）。 */
function reasoningOf(message: unknown): string {
  return textOfType(message, 'reasoning')
}

/** 模型可见输出文本（`type:'text'` 块）。 */
function textOf(message: unknown): string {
  return textOfType(message, 'text')
}

/**
 * 更新某 Step。
 *
 * 原实现只要「某个 turn 拥有这个 step」就把 `changed` 置真，即使 `update` 返回的是**同一个
 * 对象**也会重建 turns/state——这直接破坏了投影的「无关事件保持同引用」契约（dsh 靠引用
 * 变化决定是否下发变更）。现在按 `update` 的返回值判断是否真的变了。
 */
function updateStep(
  state: TraceProjectionState,
  stepId: string,
  update: (step: StepRecord) => StepRecord,
): TraceProjectionState {
  let changed = false
  const turns = state.turns.map((turn) => {
    const index = turn.steps.findIndex((step) => step.id === stepId)
    if (index < 0) return turn
    const current = turn.steps[index]
    if (current === undefined) return turn
    const next = update(current)
    if (next === current) return turn
    changed = true
    return { ...turn, steps: turn.steps.map((step) => (step.id === stepId ? next : step)) }
  })
  return changed ? { ...state, turns } : state
}

/** 更新某 Tool Call（同 `updateStep`：只有真变了才重建，保持「无关事件同引用」）。 */
function updateToolCall(
  state: TraceProjectionState,
  toolCallId: string,
  update: (toolCall: ToolCallRecord) => ToolCallRecord,
): TraceProjectionState {
  let changed = false
  const turns = state.turns.map((turn) => {
    let turnChanged = false
    const steps = turn.steps.map((step) => {
      const index = step.toolCalls.findIndex((call) => call.id === toolCallId)
      if (index < 0) return step
      const current = step.toolCalls[index]
      if (current === undefined) return step
      const next = update(current)
      if (next === current) return step
      turnChanged = true
      return {
        ...step,
        toolCalls: step.toolCalls.map((call) => (call.id === toolCallId ? next : call)),
      }
    })
    if (!turnChanged) return turn
    changed = true
    return { ...turn, steps }
  })
  return changed ? { ...state, turns } : state
}

function addPolicyChange(
  state: TraceProjectionState,
  change: Omit<PolicyChange, 'sessionId'>,
): TraceProjectionState {
  if (state.policyChanges.some((item) => item.changeId === change.changeId)) return state
  return {
    ...state,
    policyChanges: [...state.policyChanges, { ...change, sessionId: state.sessionId }],
  }
}

function addApproval(
  state: TraceProjectionState,
  record: Omit<ApprovalRecord, 'sessionId'>,
): TraceProjectionState {
  if (
    state.approvals.some(
      (item) => item.requestId === record.requestId && item.phase === record.phase,
    )
  ) {
    return state
  }
  return {
    ...state,
    approvals: [...state.approvals, { ...record, sessionId: state.sessionId }],
  }
}

/**
 * 会话事件 → trace 状态（纯 fold，同步；无关事件返回**同一引用**，符合投影契约）。
 *
 * id 派生规则：
 * `turnId = ${sessionId}:t${turn}`、`stepId = ${turnId}:s${step}`、`toolCallId = ${sessionId}:${callId}`；
 * `index` 存 0 基（`step - 1`），与 renderer 记录语义（UI 显示 index+1）一致。
 */
export function applySessionEvent(
  state: TraceProjectionState,
  event: SessionEventLike,
): TraceProjectionState {
  const data = asRecord(event.data) ?? {}
  const turnId = (turn: number): string => `${state.sessionId}:t${turn}`
  const stepId = (turn: number, step: number): string => `${turnId(turn)}:s${step}`
  const toolCallId = (callId: string): string => `${state.sessionId}:${callId}`
  const findTurn = (turn: number): TurnRecord | null =>
    state.turns.find((item) => item.id === turnId(turn)) ?? null

  switch (event.type) {
    case 'permission/preset': {
      const preset = asString(data.preset)
      if (preset === null) return state
      return addPolicyChange(state, {
        changeId: `${state.sessionId}:policy:${event.seq}`,
        kind: 'preset',
        value: preset,
        at: event.time,
      })
    }

    case 'sandbox/mode': {
      const mode = asString(data.mode)
      if (mode === null) return state
      return addPolicyChange(state, {
        changeId: `${state.sessionId}:policy:${event.seq}`,
        kind: 'sandbox',
        value: mode,
        at: event.time,
      })
    }

    case 'approval/policy': {
      const policy = asString(data.policy)
      if (policy === null) return state
      return addPolicyChange(state, {
        changeId: `${state.sessionId}:policy:${event.seq}`,
        kind: 'approval',
        value: policy,
        at: event.time,
      })
    }

    case 'approval/asked': {
      const requestId = asString(data.id)
      const toolName = asString(data.toolName)
      if (requestId === null || toolName === null) return state
      const callId = asString(data.callId)
      const reason = asString(data.reason)
      return addApproval(state, {
        requestId,
        phase: 'asked',
        toolName,
        ...(callId === null ? {} : { callId }),
        ...(reason === null ? {} : { reason }),
        at: event.time,
      })
    }

    case 'approval/decided': {
      const requestId = asString(data.id)
      const outcome = asString(data.outcome)
      if (
        requestId === null ||
        (outcome !== 'allowed-once' &&
          outcome !== 'rejected' &&
          outcome !== 'cancelled' &&
          outcome !== 'unavailable')
      ) {
        return state
      }
      const asked = state.approvals.find(
        (item) => item.requestId === requestId && item.phase === 'asked',
      )
      return addApproval(state, {
        requestId,
        phase: 'decided',
        toolName: asked?.toolName ?? 'unknown',
        ...(asked?.callId === undefined ? {} : { callId: asked.callId }),
        ...(asked?.reason === undefined ? {} : { reason: asked.reason }),
        outcome,
        at: event.time,
      })
    }

    case 'turn/start': {
      const turn = asNumber(data.turn)
      if (turn === null || findTurn(turn) !== null) return state
      const record: TurnRecord = {
        id: turnId(turn),
        userMessage: '',
        status: 'running',
        startedAt: event.time,
        steps: [],
      }
      return { ...state, turns: [...state.turns, record] }
    }

    case 'user/message': {
      const running = [...state.turns].reverse().find((turn) => turn.status === 'running')
      if (running === undefined || running.userMessage !== '') return state
      // 只认「真实用户输入」（dsh 会把系统提醒/技能上下文也以 user/message 注入，
      // 它们的 source.kind 为 plugin；这里取首个 kind==='user' 的消息作为 prompt）。
      const source = asRecord(data.source)
      if (asString(source?.kind) !== 'user') return state
      const text = textOf(data)
      if (text === '') return state
      return {
        ...state,
        turns: state.turns.map((turn) =>
          turn.id === running.id ? { ...turn, userMessage: text } : turn,
        ),
      }
    }

    case 'step/start': {
      const turn = asNumber(data.turn)
      const step = asNumber(data.step)
      if (turn === null || step === null) return state
      const parent = findTurn(turn)
      if (parent === null) return state
      const id = stepId(turn, step)
      if (parent.steps.some((item) => item.id === id)) return state
      const record: StepRecord = {
        id,
        turnId: parent.id,
        index: step - 1,
        llmReasoning: '',
        status: 'running',
        startedAt: event.time,
        toolCalls: [],
      }
      return {
        ...state,
        activeStepId: id,
        turns: state.turns.map((item) =>
          item.id === parent.id ? { ...item, steps: [...item.steps, record] } : item,
        ),
      }
    }

    case 'assistant/message': {
      const reasoning = reasoningOf(data.message)
      const text = textOf(data.message)
      if (reasoning === '' && text === '') return state
      const turn = asNumber(data.turn)
      const step = asNumber(data.step)
      const target = turn !== null && step !== null ? stepId(turn, step) : state.activeStepId
      if (target === null) return state

      let next = state
      // 思考与可见输出分开落库：前者是「它在想什么」，后者是「它说了什么」。
      if (reasoning !== '') {
        next = updateStep(next, target, (item) =>
          item.reasoning === reasoning ? item : { ...item, reasoning },
        )
      }
      if (text !== '') {
        next = updateStep(next, target, (item) =>
          item.llmReasoning === text ? item : { ...item, llmReasoning: text },
        )
      }
      if (text === '') return next
      const owner = next.turns.find((item) => item.steps.some((entry) => entry.id === target))
      if (owner === undefined || owner.assistantMessage === text) return next
      return {
        ...next,
        turns: next.turns.map((item) =>
          item.id === owner.id ? { ...item, assistantMessage: text } : item,
        ),
      }
    }

    case 'tool/call': {
      const turn = asNumber(data.turn)
      const step = asNumber(data.step)
      const callId = asString(data.callId)
      const callName = asString(data.name)
      if (turn === null || step === null || callId === null || callName === null) return state
      const parent = state.turns
        .find((item) => item.id === turnId(turn))
        ?.steps.find((item) => item.id === stepId(turn, step))
      if (parent === undefined) return state
      const id = toolCallId(callId)
      if (parent.toolCalls.some((call) => call.id === id)) return state

      let input: Record<string, unknown> = {}
      const rawArguments = asString(data.arguments)
      if (rawArguments !== null && rawArguments !== '') {
        try {
          const parsed: unknown = JSON.parse(rawArguments)
          input = asRecord(parsed) ?? { value: parsed }
        } catch {
          input = { raw: rawArguments }
        }
      }

      const record: ToolCallRecord = {
        id,
        stepId: parent.id,
        toolName: callName,
        // 会话事件不含提供方插件；M2-03 用工具注册表解析（此处占位保证 schema 合法）。
        pluginId: 'unknown',
        input,
        status: 'running',
        startedAt: event.time,
      }
      return updateStep(state, parent.id, (item) => ({
        ...item,
        toolCalls: [...item.toolCalls, record],
      }))
    }

    case 'tool/result': {
      const message = asRecord(data.message)
      const source = asRecord(message?.source)
      const contentBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : null
      const rawCallId = asString(source?.callId) ?? asString(contentBlock?.toolCallId)
      if (rawCallId === null) return state
      const failed = data.error !== undefined || contentBlock?.isError === true
      // 结果文本在 `message.content[0].content` 的 text 块里（真实 dsh：tool-result 包装块）。
      const output = textOf({ content: contentBlock?.content })
      return updateToolCall(state, toolCallId(rawCallId), (call) => ({
        ...call,
        status: failed ? 'failed' : 'success',
        endedAt: event.time,
        durationMs: Math.max(0, event.time - call.startedAt),
        ...(output === '' ? {} : { output }),
      }))
    }

    case 'step/end': {
      const turn = asNumber(data.turn)
      const step = asNumber(data.step)
      if (turn === null || step === null) return state
      const id = stepId(turn, step)
      if (state.turns.every((item) => item.steps.every((s) => s.id !== id))) return state
      const next = updateStep(state, id, (item) => ({
        ...item,
        status: 'success',
        endedAt: event.time,
      }))
      return { ...next, activeStepId: next.activeStepId === id ? null : next.activeStepId }
    }

    case 'turn/end': {
      const turn = asNumber(data.turn)
      if (turn === null) return state
      const reason = asRecord(data.reason)
      const kind = asString(reason?.kind) ?? ''
      // `kind` 只决定结局是「完成」还是「失败」，**不构成 turn 是否结束的判据**。
      // 原实现对未知 kind 直接 `return state`，于是漏列或多出任何一种 kind
      // （dsh 的 `TurnEndReasonMap` 是 merge-extensible 的，插件可自行扩展）都会让
      // turn 永久停在 running ——界面就卡在「正在执行任务」，且没有任何事件能再纠正它。
      //
      // 已知取值（dsh `packages/core/session/src/types.ts` §TurnEndReasonMap）：
      // completed / aborted / blocked / error / max-tokens / interrupted / forked。
      // 后六者都表示「这一轮被关闭了，且不是正常完成」，故一律记 failed。
      const status: TurnRecord['status'] = kind === 'completed' ? 'completed' : 'failed'
      // 失败原因：dsh 在 `reason.error = { code, message }` 里给出可读解释
      // （如 `UNSUPPORTED_REASONING_EFFORT` / `MISSING_CREDENTIAL`）。这里原样带出去，
      // 由渲染层合成一条错误行——丢掉它就等于「用户看到消息发出去了，然后什么都没有」（D03）。
      const failure = status === 'failed' ? asRecord(reason?.error) : null
      const failureCode = asString(failure?.code)
      const failureMessage = asString(failure?.message)
      return {
        ...state,
        turns: state.turns.map((item) =>
          item.id === turnId(turn)
            ? {
                ...item,
                status,
                endedAt: event.time,
                ...(failureCode === null ? {} : { failureCode }),
                ...(failureMessage === null ? {} : { failureMessage }),
              }
            : item,
        ),
      }
    }

    default:
      return state
  }
}
