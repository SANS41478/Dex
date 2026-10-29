import { z } from 'zod'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

export const settingsSecretSchema = z.object({
  path: z.array(z.string()),
  set: z.boolean(),
})
export type SettingsSecret = z.infer<typeof settingsSecretSchema>

export const settingsNamespaceSchema = z.object({
  autoGenerate: z.boolean(),
  ns: z.string().min(1),
  schema: jsonValueSchema,
  value: jsonValueSchema,
  base: jsonValueSchema.optional(),
  user: jsonValueSchema.optional(),
  applies: z.literal('live'),
  secrets: z.array(settingsSecretSchema),
  revision: z.number().int().nonnegative(),
})
export type SettingsNamespace = z.infer<typeof settingsNamespaceSchema>

export const settingsDescribeSchema = z.object({
  writable: z.boolean(),
  hasDocument: z.boolean(),
  namespaces: z.array(settingsNamespaceSchema),
})
export type SettingsDescribe = z.infer<typeof settingsDescribeSchema>

export const settingsPathOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.array(z.string()).min(1), value: jsonValueSchema }),
  z.object({ op: z.literal('unset'), path: z.array(z.string()).min(1) }),
])
export type SettingsPathOperation = z.infer<typeof settingsPathOperationSchema>

export const settingsMutateRequestSchema = z.object({
  namespace: z.string().min(1),
  operations: z.array(settingsPathOperationSchema).min(1),
  expectedRevision: z.number().int().nonnegative(),
})
export type SettingsMutateRequest = z.infer<typeof settingsMutateRequestSchema>

export const settingsMutateResultSchema = settingsNamespaceSchema
export type SettingsMutateResult = z.infer<typeof settingsMutateResultSchema>

export const settingsMutationResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: settingsMutateResultSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  }),
])
export type SettingsMutationResponse = z.infer<typeof settingsMutationResponseSchema>
