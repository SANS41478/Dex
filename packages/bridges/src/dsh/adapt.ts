/**
 * dsh 接触面的薄适配（只允许出现在本目录）。
 *
 * 官方对象 → 类型中立契约（`contract.ts`）：
 * - `entry.options.name/group`、`entry.disabled`、`entry.fiber` → `DshLoaderEntry`；
 * - `fiber.store` 的值是 `Impl { fiber }`，这里投影为「服务名 → 提供方 uid」。
 */
import type { DshFiberRef, DshFiberStateValue, DshLoaderEntry } from './contract'

export interface DshRawServiceImpl {
  readonly fiber?: { readonly uid: number | null } | undefined
}

export interface DshRawFiber {
  readonly uid: number | null
  readonly state: DshFiberStateValue
  readonly inject?: Readonly<Record<string, unknown>> | undefined
  readonly store?: Readonly<Record<string, DshRawServiceImpl>> | undefined
}

export interface DshRawEntry {
  readonly id: string
  readonly options?:
    | {
        readonly name?: string | undefined
        readonly group?: boolean | undefined
        readonly config?: unknown
      }
    | undefined
  readonly disabled?: boolean | undefined
  readonly config?: unknown
  readonly fiber?: DshRawFiber | undefined
}

const SENSITIVE_CONFIG_KEY = /api[-_]?key|token|secret|password|credential|authorization|path/i

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 只保留非敏感的顶层配置键名，不返回任何配置值。 */
export function extractConfigKeys(value: unknown): {
  readonly readable: boolean
  readonly keys: readonly string[]
} {
  const record = asRecord(value)
  if (record === null) return { readable: false, keys: [] }
  return {
    readable: true,
    keys: Object.keys(record)
      .filter((key) => !SENSITIVE_CONFIG_KEY.test(key))
      .sort(),
  }
}

export function adaptFiber(raw: DshRawFiber): DshFiberRef {
  const ref: DshFiberRef = {
    uid: raw.uid,
    state: raw.state,
    inject: raw.inject ?? {},
  }
  if (raw.store === undefined) return ref

  const store: Record<string, number | null> = {}
  for (const [service, impl] of Object.entries(raw.store)) {
    store[service] = impl.fiber?.uid ?? null
  }
  return { ...ref, store }
}

export function adaptEntry(raw: DshRawEntry): DshLoaderEntry {
  const entry: DshLoaderEntry = {
    id: raw.id,
    group: raw.options?.group === true,
    disabled: raw.disabled === true,
  }
  const withName =
    raw.options?.name === undefined ? entry : { ...entry, moduleName: raw.options.name }
  const config = raw.options?.config ?? raw.config
  const withConfig =
    config === undefined
      ? withName
      : (() => {
          const metadata = extractConfigKeys(config)
          return { ...withName, configReadable: metadata.readable, configKeys: metadata.keys }
        })()
  return raw.fiber === undefined ? withConfig : { ...withConfig, fiber: adaptFiber(raw.fiber) }
}

export function adaptEntries(entries: Iterable<unknown>): DshLoaderEntry[] {
  const adapted: DshLoaderEntry[] = []
  for (const raw of entries) adapted.push(adaptEntry(raw as DshRawEntry))
  return adapted
}
