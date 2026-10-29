import { z } from 'zod'

/**
 * 插件管理面（UI-10）的协议形状。
 *
 * 数据源是 dsh 宿主里的 `pluginManager` 服务（同为官方插件管理 UI 的数据源）：
 * `listPlugins` / `listBundles` / `setPluginEnabled`。这里只保留 Dex 界面需要的字段，
 * 并沿用上游语义：`patchId` 存在 = 可通过 profile 补丁寻址（应用内可启停）；
 * `readOnlyReason` = 不可管理的原因（管理链自身 protected / 嵌套 include 不可寻址）。
 */

/** dsh fiber 相位（与 `@deepseek-ai/dsh-host-plugin-inventory` 的投影一致；null = 已销毁）。 */
export const pluginFiberPhaseSchema = z.enum([
  'pending',
  'loading',
  'active',
  'failed',
  'unloading',
])
export type PluginFiberPhase = z.infer<typeof pluginFiberPhaseSchema>

/** 行不可通过 profile 补丁修改的原因（照 dsh plugin-manager 词汇）。 */
export const pluginReadOnlyReasonSchema = z.enum(['management-required', 'unaddressable'])
export type PluginReadOnlyReason = z.infer<typeof pluginReadOnlyReasonSchema>

export const pluginInfoSchema = z.object({
  /** Loader 条目 id（启停请求原样回传）。 */
  entryId: z.string().min(1),
  moduleName: z.string().min(1),
  /** 当前有效启用状态（含祖先分组与各层补丁）。 */
  enabled: z.boolean(),
  fiberPhase: pluginFiberPhaseSchema.nullable(),
  /** 存在即可通过 profile 补丁启停（应用内开关可用）。 */
  patchId: z.string().min(1).optional(),
  readOnlyReason: pluginReadOnlyReasonSchema.optional(),
  /** 该行对应的设置命名空间是否存在（决定是否显示「配置」入口）。 */
  hasSettings: z.boolean(),
  title: z.string().optional(),
  description: z.string().optional(),
})
export type PluginInfo = z.infer<typeof pluginInfoSchema>

export const pluginBundleInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  /** 选入 profile manifest（加载报错时层被跳过）。 */
  enabled: z.boolean(),
  /** 安装方随 dsh 提供、可由用户点开（官方 OPTIONAL_BUNDLES）。 */
  optional: z.boolean(),
  removable: z.boolean(),
  readOnlyReason: pluginReadOnlyReasonSchema.optional(),
  /** 加载/兼容性问题码（如 `not-bundle` / `incompatible-version`）。 */
  errorCode: z.string().optional(),
})
export type PluginBundleInfo = z.infer<typeof pluginBundleInfoSchema>

export const pluginsListSchema = z.object({
  /** `pluginManager` 服务在宿主里可用（false = 只读清单）。 */
  managementAvailable: z.boolean(),
  /** HMR 服务可用（false = 启停/配置需要重启宿主才生效）。 */
  hmrAvailable: z.boolean(),
  plugins: z.array(pluginInfoSchema),
  bundles: z.array(pluginBundleInfoSchema),
})
export type PluginsList = z.infer<typeof pluginsListSchema>

export const pluginsSetEnabledRequestSchema = z.object({
  entryId: z.string().min(1),
  enabled: z.boolean(),
})
export type PluginsSetEnabledRequest = z.infer<typeof pluginsSetEnabledRequestSchema>

/**
 * 启停结果（照 dsh `ChangeResult` 裁剪）：
 * - `applied` 已即时生效；`restart-required` 已写入、需重启宿主；
 * - `overridden` 已写入但被更高层补丁覆盖（如应用内置 overlay）；
 * - `failed` 未生效，附 `errorCode`；`cancelled` 为安装类操作的取消（启停不会出现）。
 */
export const pluginChangeResultSchema = z.object({
  changed: z.boolean(),
  application: z.enum(['applied', 'restart-required', 'overridden', 'failed', 'cancelled']),
  enabled: z.boolean().optional(),
  errorCode: z.string().optional(),
  /** 操作后仍处于非激活态、且与本次操作无关的既有条目诊断（原样透传）。 */
  warnings: z.array(z.string()).optional(),
})
export type PluginChangeResult = z.infer<typeof pluginChangeResultSchema>
