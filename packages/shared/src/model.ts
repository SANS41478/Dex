import { z } from 'zod'

export const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

export const providerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(modelInfoSchema),
  credential: z.object({ configured: z.boolean(), writable: z.boolean() }),
})
export type ProviderInfo = z.infer<typeof providerInfoSchema>

/**
 * 一条**可配置 provider 目录**项（照 dsh `LlmConfigurableProvider`）：
 * 不只列已生效的路由，还给出它的配置地址（settingsNs + settingsPath），
 * 设置界面据此渲染卡片并知道往哪写。只增字段，v1 兼容。
 */
export const configurableProviderSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string().min(1),
  settingsPath: z.array(z.string()),
  /** true = 适配器只因配置声明才知道这条路由（用户自定义 / 中转站）。 */
  declared: z.boolean().optional(),
  /** 配置诊断（该路由当前不可用的原因）。 */
  error: z.string().optional(),
  /** 当前是否已注册为活体路由。 */
  live: z.boolean(),
})
export type ConfigurableProvider = z.infer<typeof configurableProviderSchema>

export const modelCatalogSchema = z.object({
  providers: z.array(providerInfoSchema),
  /** 可配置目录（含未生效路由）；旧发送方缺省为空数组。 */
  configurable: z.array(configurableProviderSchema).default([]),
  selection: modelSelectionSchema.nullable(),
  /** dsh 全局默认模型（`agent-default-model` 设置）；未配置为 null。 */
  defaultSelection: modelSelectionSchema.nullable().default(null),
})
export type ModelCatalog = z.infer<typeof modelCatalogSchema>

/** 「从提供商拉取模型」的结果条目（照 dsh `LlmDiscoveredModel`）。 */
export const discoveredModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.string().min(1)).optional(),
})
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>

export const modelDiscoveryRequestSchema = z.object({
  namespace: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
})
export type ModelDiscoveryRequest = z.infer<typeof modelDiscoveryRequestSchema>
