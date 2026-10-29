import { z } from 'zod'

export const stepStatusSchema = z.enum(['pending', 'running', 'success', 'failed'])
export type StepStatus = z.infer<typeof stepStatusSchema>

export const turnStatusSchema = z.enum(['running', 'completed', 'failed'])
export type TurnStatus = z.infer<typeof turnStatusSchema>

export const toolCallStatusSchema = z.enum(['running', 'success', 'failed'])
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>

export const pluginTypeSchema = z.enum(['model', 'tool', 'skill', 'scheduler', 'sandbox', 'other'])
export type PluginType = z.infer<typeof pluginTypeSchema>

export const nodeStatusSchema = z.enum(['active', 'inactive', 'error'])
export type NodeStatus = z.infer<typeof nodeStatusSchema>

export const controlCapabilitiesSchema = z.object({
  canEnable: z.literal(false),
  canDisable: z.literal(false),
  canConfigure: z.literal(false),
})
export type ControlCapabilities = z.infer<typeof controlCapabilitiesSchema>

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: pluginTypeSchema,
  status: nodeStatusSchema,
  /** 完整模块说明符（Loader 的 `options.name`）；内建行缺省。M1-07 详情面板用（增量字段）。 */
  moduleName: z.string().min(1).optional(),
  disabled: z.boolean().optional(),
  configReadable: z.boolean().optional(),
  configKeys: z.array(z.string().min(1)).optional(),
  controlCapabilities: controlCapabilitiesSchema.optional(),
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const graphLinkSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.enum(['inject', 'runtime']),
})
export type GraphLink = z.infer<typeof graphLinkSchema>

export const toolCallSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  pluginId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown().optional(),
  status: toolCallStatusSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
})
export type ToolCall = z.infer<typeof toolCallSchema>

export const stepSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  index: z.number().int().nonnegative(),
  llmReasoning: z.string(),
  toolCalls: z.array(toolCallSchema),
  status: stepStatusSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  pluginNodeId: z.string().min(1).optional(),
})
export type Step = z.infer<typeof stepSchema>

export const turnSchema = z.object({
  id: z.string().min(1),
  userMessage: z.string(),
  steps: z.array(stepSchema),
  status: turnStatusSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
})
export type Turn = z.infer<typeof turnSchema>
