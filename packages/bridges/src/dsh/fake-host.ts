import type {
  DshEventMap,
  DshEventName,
  DshFiberRef,
  DshFiberStateValue,
  DshHost,
  DshLoaderEntry,
} from './contract'
import { DshFiberState } from './contract'

type RawListener = (...args: unknown[]) => void

/** 测试驱动面：模拟 Loader 条目与 fiber 生命周期的变化。 */
export interface FakeDshDriver {
  /** 新增条目并触发 `loader/entry-init`。 */
  initEntry(entry: DshLoaderEntry): void
  /** 挂载 fiber 并触发 `internal/plugin`。 */
  attachFiber(entryId: string, fiber: DshFiberRef): void
  /** 迁移 fiber 状态并触发 `internal/status`（携带旧值）。 */
  transition(entryId: string, next: DshFiberStateValue): void
  /** 卸载 fiber（uid=null、DISPOSED）并触发 `internal/plugin`，条目保留。 */
  detachFiber(entryId: string): void
  /** 移除条目（等价 loader 条目删除）并触发 `internal/plugin`，条目从树中消失。 */
  removeEntry(entryId: string): void
  /** 模拟 fiber 卸载：清空全部订阅（等价 cordis 的 fiber 自动清理）。 */
  disposeAll(): void
}

export interface FakeDshHost extends DshHost {
  readonly driver: FakeDshDriver
}

export function createFakeDshHost(initial: readonly DshLoaderEntry[] = []): FakeDshHost {
  const entries = new Map<string, DshLoaderEntry>()
  for (const entry of initial) entries.set(entry.id, entry)

  const listeners = new Map<DshEventName, Set<RawListener>>()

  function emit<K extends DshEventName>(event: K, ...args: Parameters<DshEventMap[K]>): void {
    const set = listeners.get(event)
    if (set === undefined) return
    for (const listener of [...set]) listener(...args)
  }

  function requireEntry(entryId: string): DshLoaderEntry {
    const entry = entries.get(entryId)
    if (entry === undefined) throw new Error(`unknown entry: ${entryId}`)
    return entry
  }

  function requireFiber(entry: DshLoaderEntry): DshFiberRef {
    if (entry.fiber === undefined) throw new Error(`entry has no fiber: ${entry.id}`)
    return entry.fiber
  }

  return {
    loader: {
      entries: () => entries.values(),
    },
    on(event, listener, _options) {
      const set = listeners.get(event) ?? new Set<RawListener>()
      listeners.set(event, set)
      set.add(listener as unknown as RawListener)

      let active = true
      return () => {
        if (!active) return false
        active = false
        set.delete(listener as unknown as RawListener)
        return true
      }
    },
    driver: {
      initEntry(entry) {
        entries.set(entry.id, entry)
        emit('loader/entry-init', entry)
      },
      attachFiber(entryId, fiber) {
        const entry = requireEntry(entryId)
        entries.set(entryId, { ...entry, fiber })
        emit('internal/plugin', fiber)
      },
      transition(entryId, next) {
        const entry = requireEntry(entryId)
        const fiber = requireFiber(entry)
        const moved: DshFiberRef = {
          uid: fiber.uid,
          state: next,
          inject: fiber.inject,
          ...(fiber.store === undefined ? {} : { store: fiber.store }),
        }
        entries.set(entryId, { ...entry, fiber: moved })
        emit('internal/status', moved, fiber.state)
      },
      detachFiber(entryId) {
        const entry = requireEntry(entryId)
        const fiber = requireFiber(entry)
        entries.set(entryId, {
          id: entry.id,
          group: entry.group,
          disabled: entry.disabled,
          ...(entry.moduleName === undefined ? {} : { moduleName: entry.moduleName }),
        })
        emit('internal/plugin', { uid: null, state: DshFiberState.DISPOSED, inject: fiber.inject })
      },
      removeEntry(entryId) {
        const entry = requireEntry(entryId)
        const inject = entry.fiber?.inject ?? {}
        entries.delete(entryId)
        emit('internal/plugin', { uid: null, state: DshFiberState.DISPOSED, inject })
      },
      disposeAll() {
        for (const set of listeners.values()) set.clear()
      },
    },
  }
}
