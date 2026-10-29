import { z } from 'zod'
import { modelSelectionSchema } from './model'
import { approvalPolicySchema, permissionPresetSchema } from './policy'

export const appErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
})
export type AppError = z.infer<typeof appErrorSchema>

export const workspacePickResultSchema = z.discriminatedUnion('canceled', [
  z.object({ canceled: z.literal(true) }),
  z.object({ canceled: z.literal(false), path: z.string().min(1) }),
])
export type WorkspacePickResult = z.infer<typeof workspacePickResultSchema>

export const workspaceFilesPickResultSchema = z.discriminatedUnion('canceled', [
  z.object({ canceled: z.literal(true) }),
  z.object({
    canceled: z.literal(false),
    files: z.array(z.string().min(1)).min(1),
  }),
])
export type WorkspaceFilesPickResult = z.infer<typeof workspaceFilesPickResultSchema>

export const sessionCreateRequestSchema = z.object({
  workspacePath: z.string().min(1),
  selection: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.string().min(1).optional(),
    })
    .optional(),
})
export type SessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>

export const sessionCreateResultSchema = z.object({
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
})
export type SessionCreateResult = z.infer<typeof sessionCreateResultSchema>

export const sessionPromptRequestSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().trim().min(1),
  attachments: z
    .array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(['file', 'image']),
      }),
    )
    .optional(),
  permissionPreset: permissionPresetSchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  reasoningEffort: z.string().min(1).optional(),
})
export type SessionPromptRequest = z.infer<typeof sessionPromptRequestSchema>

export const sessionPromptResultSchema = z.object({
  requestId: z.string().min(1),
  /**
   * 本轮被**降级执行**的说明（如权限档位 runtime 不支持，已按 workspace-write 跑）。
   *
   * 只增字段。存在的意义是「降级但不静默」：过去这种降级被写成一次硬失败
   * `POLICY_UNSUPPORTED`，于是真因（模型不支持该推理档位 / provider 缺凭据）
   * 被顶掉，用户被引向错误方向（黑盒报告 D04）。
   */
  notice: z.string().min(1).optional(),
})
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>

export const sessionActivateRequestSchema = z.object({
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
  /**
   * 本次会话要用的模型选择。
   *
   * 历史会话走控制桥 resume 时，dsh 的 `agents.resume({ agentOptions })` 需要一个模型；
   * 不传就等于「不管选了什么模型，续聊都落到 dsh 的默认模型上」，而默认模型与本机已配置的
   * 凭据未必对得上。所以激活时把界面上当前的选择一并带上（dsh Web 层同样是传当前选择）。
   */
  selection: modelSelectionSchema.optional(),
})
export type SessionActivateRequest = z.infer<typeof sessionActivateRequestSchema>

export const sessionActivateResultSchema = z.object({
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
})
export type SessionActivateResult = z.infer<typeof sessionActivateResultSchema>

/** 停止请求：取消该会话的活跃轮次（SDK stdio 无 cancel，main 转走 `/dex-control`）。 */
export const sessionStopRequestSchema = z.object({
  sessionId: z.string().min(1),
})
export type SessionStopRequest = z.infer<typeof sessionStopRequestSchema>

export const sessionStopResultSchema = z.object({
  accepted: z.literal(true),
})
export type SessionStopResult = z.infer<typeof sessionStopResultSchema>
