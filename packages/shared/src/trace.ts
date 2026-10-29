import { z } from 'zod'

/** 执行流记录（renderer trace store 与 dsh 侧投影共用；M2-02 从 renderer 上移）。 */
export const toolCallRecordSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  pluginId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown().optional(),
  status: z.enum(['running', 'success', 'failed']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
})
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>

export const stepRecordSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  index: z.number().int().nonnegative(),
  /**
   * 该步模型**可见输出文本**（`assistant/message` 里 `type:'text'` 的块）。
   *
   * 语义修正（观测体验改造）：过去 `trace-fold` 不区分内容块类型，把
   * `type:'reasoning'`（思考）与 `type:'text'`（回答）的文本**拼成一坨**塞进这里，
   * 于是时间线/执行流上那一行「推理摘要」实际是数千字的思考正文，被单行省略号
   * 截成一串看不懂的碎片。思考已独立到 `reasoning` 字段（只增字段）。
   */
  llmReasoning: z.string(),
  /**
   * 该步模型的**思考原文**（`assistant/message` 里 `type:'reasoning'` 的块，只增字段）。
   *
   * 真相源不截断——它可能很长（单步数 KB）；截断/折叠属于渲染层决策，不在投影里丢信息。
   */
  reasoning: z.string().optional(),
  status: z.enum(['pending', 'running', 'success', 'failed']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  toolCalls: z.array(toolCallRecordSchema),
})
export type StepRecord = z.infer<typeof stepRecordSchema>

export const turnRecordSchema = z.object({
  id: z.string().min(1),
  userMessage: z.string(),
  assistantMessage: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  /**
   * 失败原因（只增字段）。
   *
   * dsh 的 `turn/end` 在失败时带 `reason.error = { code, message }`——过去这两个字段
   * 被 `trace-fold` 直接丢弃，`TurnRecord` 只剩一个 `status: 'failed'`，于是界面上
   * 「消息发出去了，然后什么都没发生」：用户既不知道失败，也不知道为什么（黑盒报告 D03）。
   * 现在原样带到渲染层，由 `core/chat.ts` 合成一条错误行。
   */
  failureCode: z.string().min(1).optional(),
  failureMessage: z.string().min(1).optional(),
  steps: z.array(stepRecordSchema),
})
export type TurnRecord = z.infer<typeof turnRecordSchema>

export const policyChangeSchema = z.object({
  sessionId: z.string().min(1),
  changeId: z.string().min(1),
  kind: z.enum(['preset', 'sandbox', 'approval']),
  value: z.string().min(1),
  at: z.number().int().nonnegative(),
})
export type PolicyChange = z.infer<typeof policyChangeSchema>

export const approvalRecordSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  phase: z.enum(['asked', 'decided']),
  toolName: z.string().min(1),
  callId: z.string().min(1).optional(),
  reason: z.string().optional(),
  outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']).optional(),
  at: z.number().int().nonnegative(),
})
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>

export const traceStateSchema = z.object({
  turns: z.array(turnRecordSchema),
  activeStepId: z.string().nullable(),
  policyChanges: z.array(policyChangeSchema),
  approvals: z.array(approvalRecordSchema),
})
export type TraceState = z.infer<typeof traceStateSchema>

export const initialTraceState: TraceState = {
  turns: [],
  activeStepId: null,
  policyChanges: [],
  approvals: [],
}
