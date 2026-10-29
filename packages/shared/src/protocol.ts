import { z } from 'zod'
import { graphLinkSchema, graphNodeSchema } from './domain'

export const protocolVersion = 1
export const DEFAULT_WS_PORT = 4319

const timestamp = z.number().int().nonnegative()
const id = z.string().min(1)

const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    v: z.literal(protocolVersion),
    type: z.literal(type),
    ts: timestamp,
    payload,
  })

export const messageSchema = z.discriminatedUnion('type', [
  envelope(
    'graph.snapshot',
    z.object({ nodes: z.array(graphNodeSchema), links: z.array(graphLinkSchema) }),
  ),
  envelope(
    'graph.upsert',
    z.object({ nodes: z.array(graphNodeSchema), links: z.array(graphLinkSchema) }),
  ),
  envelope('graph.remove', z.object({ nodeIds: z.array(id), linkIds: z.array(id) })),
  envelope(
    'host.status',
    z.object({
      phase: z.enum(['starting', 'ready', 'stopped', 'error', 'missing']),
      detail: z.string().optional(),
    }),
  ),
  // 会话级运行状态（宿主权威事实）。dsh 的 SDK 会以 `session.status` 通知下发
  // `{ sessionId, status: 'idle' | 'running' }`，main 原样转成这条消息。
  // 它是「正在执行任务」的**唯一真源**——不得再用 `turn.status` 推导：
  // 一旦 `turn/end` 丢失（侧信道重连窗口），turn 会永久停在 running。
  envelope(
    'session.status',
    z.object({
      sessionId: id,
      status: z.enum(['idle', 'running']),
    }),
  ),
  envelope('trace.turn.start', z.object({ turnId: id, userMessage: z.string(), at: timestamp })),
  envelope('trace.turn.update', z.object({ turnId: id, userMessage: z.string(), at: timestamp })),
  envelope(
    'trace.step.start',
    z.object({ turnId: id, stepId: id, index: z.number().int().nonnegative(), at: timestamp }),
  ),
  envelope(
    'trace.step.reasoning',
    z.object({
      stepId: id,
      /**
       * 该步模型思考原文（只增消息，`protocolVersion` 保持 1）。
       *
       * 为什么单独一条：`assistant/message` 在 `tool/call` **之前**就已到达，
       * 但旧实现只在 `step/end` 才把文本带出去——于是「它在想什么」要等整步
       * 跑完才可见。这条消息让思考在工具执行期间就能显示（时间线/执行流的思考行）。
       */
      reasoning: z.string(),
      at: timestamp,
    }),
  ),
  envelope(
    'trace.step.end',
    z.object({
      stepId: id,
      status: z.enum(['success', 'failed']),
      /** 该步模型可见输出文本（`assistant/message` 里 `type:'text'` 的块）。 */
      llmReasoning: z.string().optional(),
      /**
       * 该步模型思考原文（`type:'reasoning'` 的块，只增字段）。
       * 与 `llmReasoning` 分开发，渲染层才能把「思考」与「回答」分开呈现。
       */
      reasoning: z.string().optional(),
      at: timestamp,
    }),
  ),
  envelope(
    'trace.tool.start',
    z.object({
      toolCallId: id,
      stepId: id,
      toolName: z.string().min(1),
      pluginId: id,
      input: z.record(z.string(), z.unknown()),
      at: timestamp,
    }),
  ),
  envelope(
    'trace.tool.end',
    z.object({
      toolCallId: id,
      stepId: id,
      status: z.enum(['success', 'failed']),
      output: z.unknown().optional(),
      durationMs: z.number().nonnegative().optional(),
      at: timestamp,
    }),
  ),
  envelope(
    'trace.turn.end',
    z.object({
      turnId: id,
      status: z.enum(['completed', 'failed']),
      assistantMessage: z.string().optional(),
      // 失败原因（只增字段）：dsh `turn/end` 的 `reason.error.{code,message}` 原样透传，
      // 供聊天区把「失败」和「为什么失败」渲染出来。见 `trace.ts` 的 `turnRecordSchema`。
      failureCode: z.string().min(1).optional(),
      failureMessage: z.string().min(1).optional(),
      at: timestamp,
    }),
  ),
  envelope(
    'trace.policy',
    z.object({
      sessionId: id,
      changeId: id,
      kind: z.enum(['preset', 'sandbox', 'approval']),
      value: z.string().min(1),
      at: timestamp,
    }),
  ),
  envelope(
    'trace.approval',
    z.object({
      sessionId: id,
      requestId: id,
      phase: z.enum(['asked', 'decided']),
      toolName: z.string().min(1),
      callId: id.optional(),
      reason: z.string().optional(),
      outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']).optional(),
      at: timestamp,
    }),
  ),
])

export type Message = z.infer<typeof messageSchema>
export type MessageType = Message['type']
export type TraceMessage = Extract<Message, { type: `trace.${string}` }>
export type GraphMessage = Extract<Message, { type: `graph.${string}` }>
export type HostMessage = Extract<Message, { type: `host.${string}` }>
export type SessionMessage = Extract<Message, { type: `session.${string}` }>
export type SessionStatus = SessionMessage['payload']

export type ParseResult = { ok: true; message: Message } | { ok: false; error: z.ZodError }

export function parseEnvelope(data: unknown): ParseResult {
  const result = messageSchema.safeParse(data)
  if (result.success) return { ok: true, message: result.data }
  return { ok: false, error: result.error }
}

export function makeMessage<T extends MessageType>(
  type: T,
  payload: Extract<Message, { type: T }>['payload'],
): Extract<Message, { type: T }> {
  return { v: protocolVersion, type, ts: Date.now(), payload } as Extract<Message, { type: T }>
}

export function encodeMessage(message: Message): string {
  return JSON.stringify(message)
}

export function isTraceMessage(message: Message): message is TraceMessage {
  return message.type.startsWith('trace.')
}

export function isGraphMessage(message: Message): message is GraphMessage {
  return message.type.startsWith('graph.')
}

export function isHostMessage(message: Message): message is HostMessage {
  return message.type.startsWith('host.')
}

export function isSessionMessage(message: Message): message is SessionMessage {
  return message.type.startsWith('session.')
}
