/**
 * SDK stdio 线协议最小镜像。
 *
 * 官方 `@deepseek-ai/dsh-sdk-protocol` 面向 workspace 内部（peer 依赖重、alpha），
 * 桥接层只镜像用到的方法与形状：NDJSON JSON-RPC 2.0 帧 + 校验。
 * 官方方法全集（闭集）：initialize / session/prompt / shutdown；
 * 通知：session.event / session.status / subagent.started / subagent.finished。
 */
import { z } from 'zod'

export const sdkIdSchema = z.union([z.string(), z.number()])

export const sdkErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
})

export const sdkRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: sdkIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const sdkResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: sdkIdSchema,
  result: z.unknown().optional(),
  error: sdkErrorSchema.optional(),
})

export const sdkNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export type SdkRequest = z.infer<typeof sdkRequestSchema>
export type SdkResponse = z.infer<typeof sdkResponseSchema>
export type SdkNotification = z.infer<typeof sdkNotificationSchema>

export type SdkFrame =
  | { readonly kind: 'request'; readonly frame: SdkRequest }
  | { readonly kind: 'response'; readonly frame: SdkResponse }
  | { readonly kind: 'notification'; readonly frame: SdkNotification }

/** JSON-RPC 标准错误码：无注册处理器（官方 README 承诺的行为）。 */
export const SDK_METHOD_NOT_FOUND = -32601

export function createSdkRequest(
  id: SdkRequest['id'],
  method: string,
  params?: unknown,
): SdkRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params }
}

/** 帧编码：一行一条消息（`\n` 结尾）。 */
export function encodeSdkFrame(frame: SdkRequest | SdkResponse | SdkNotification): string {
  return `${JSON.stringify(frame)}\n`
}

/** 行解析：空行与非法帧返回 null（官方语义：malformed lines are ignored）。 */
export function parseSdkFrame(line: string): SdkFrame | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return null
  }

  const request = sdkRequestSchema.safeParse(data)
  if (request.success) return { kind: 'request', frame: request.data }

  const response = sdkResponseSchema.safeParse(data)
  if (response.success) return { kind: 'response', frame: response.data }

  const notification = sdkNotificationSchema.safeParse(data)
  if (notification.success) return { kind: 'notification', frame: notification.data }

  return null
}

/** 探活：未知方法请求会得到 `-32601` 错误响应。 */
export function isMethodNotFound(response: SdkResponse): boolean {
  return response.error?.code === SDK_METHOD_NOT_FOUND
}

/** 会话运行状态的取值域（与 dsh `AgentStatus` 对齐：`idle | running`）。 */
export type SdkSessionStatus = 'idle' | 'running'

/**
 * `session.status` 通知：宿主权威的**会话级**运行状态。
 *
 * 这是「正在执行任务」唯一可靠的收尾信号——`turn/end` 只在持久事件流里出现，
 * 侧信道重连窗口内会丢；而这条通知由 SDK server 直接订阅 `agent/status` 产生，
 * 宿主每次状态**变化**都发一次，且会话列表基线可在重连后纠正。
 */
export const sdkSessionStatusNotificationSchema = z.object({
  method: z.literal('session.status'),
  params: z.object({
    sessionId: z.string().min(1),
    status: z.enum(['idle', 'running']),
  }),
})

export interface SdkSessionStatusPayload {
  readonly sessionId: string
  readonly status: SdkSessionStatus
}

/** 解析 `session.status` 通知；形状不符返回 null（不抛异常，未知通知一律忽略）。 */
export function parseSessionStatusNotification(
  frame: SdkNotification,
): SdkSessionStatusPayload | null {
  const parsed = sdkSessionStatusNotificationSchema.safeParse(frame)
  if (!parsed.success) return null
  return { sessionId: parsed.data.params.sessionId, status: parsed.data.params.status }
}
