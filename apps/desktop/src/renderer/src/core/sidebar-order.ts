/**
 * 侧栏「组内手动顺序」纯逻辑（key `dex.sidebar.order.v1`）。
 *
 * 语义照抄 dsh（`F:\DSH\deepseek-harness\packages\client\ui-workspace\src\client\tree.ts:168`
 * 的 `reconcileManualOrder` + `WorkspaceBrowser.tsx:182` 的 `sessionDragOrder`）：
 * 保存过的顺序优先；新成员按「置顶 → 最近使用」补位；顺序以账号（工作区 id / 未分组）
 * 为单位持久化在浏览器本地。
 *
 * 与 dsh 的三处**有意差异**：
 * - 不保留归档槽位：Dex 的「隐藏」语义是从列表移除，直接掉出成员集（dsh 的归档会留位）；
 * - 不做 fork 邻近：Dex 的 `SessionSummary` 未透出 `parentId`（无数据可用）；
 * - 不跨账号拖动：会话归属由 cwd 决定（dsh `entity.ts:101`），跨组移动本就不存在。
 */
import type { SessionSummary } from '@dexagent/shared'

export const SIDEBAR_ORDER_STORAGE_KEY = 'dex.sidebar.order.v1'
/** 未分组桶的账号 key，与 `SessionList` 的视图 key 同源。 */
export const UNGROUPED_ORDER_KEY = '__ungrouped__'

export type SidebarOrderMap = Readonly<Record<string, readonly string[]>>

export function parseOrderMap(raw: string | null): SidebarOrderMap {
  if (raw === null || raw === '') return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, order]) => {
      if (key === '' || !Array.isArray(order)) return []
      const ids = order.filter((id): id is string => typeof id === 'string' && id !== '')
      return ids.length === 0 ? [] : [[key, ids] as const]
    })
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

export function serializeOrderMap(map: SidebarOrderMap): string {
  return JSON.stringify(map)
}

/** localStorage 可能不存在（纯 Node 单测）或写入失败（隐私模式），这里一律静默。 */
export function readOrderMap(): SidebarOrderMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    return parseOrderMap(localStorage.getItem(SIDEBAR_ORDER_STORAGE_KEY))
  } catch {
    return {}
  }
}

export function writeOrderMap(map: SidebarOrderMap): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SIDEBAR_ORDER_STORAGE_KEY, serializeOrderMap(map))
  } catch {
    // 手动顺序丢了只是回到默认排序，不值得为它报错。
  }
}

/** 记录一次拖动后的顺序；空数组视为清除该账号的保存顺序。 */
export function withSessionOrder(
  map: SidebarOrderMap,
  accountKey: string,
  order: readonly string[],
): SidebarOrderMap {
  if (order.length === 0) {
    const next = { ...map }
    delete next[accountKey]
    return next
  }
  return { ...map, [accountKey]: [...order] }
}

export type SessionOrderSummary = Pick<SessionSummary, 'updatedAt'>

/** dsh `orderByRecency`（tree.ts:143）：updatedAt 降序，id 升序决胜；缺 summary 的成员被略过。 */
function orderByRecency(
  ids: readonly string[],
  summaries: Readonly<Record<string, SessionOrderSummary | undefined>>,
): string[] {
  return ids
    .flatMap((id) => {
      const summary = summaries[id]
      if (summary === undefined) return []
      return [{ id, rank: summary.updatedAt ?? 0 }]
    })
    .sort((left, right) => {
      if (left.rank !== right.rank) return right.rank - left.rank
      return left.id < right.id ? -1 : 1
    })
    .map((item) => item.id)
}

/**
 * 把保存过的手动顺序与当前成员对账：
 * 保存顺序里仍存在的成员保序在前 → 未入保存顺序的置顶成员随后 → 其余按最近使用降序。
 * 未知 id 与重复项被丢弃；缺 summary 的置顶成员等待其 summary（与 dsh 一致）。
 */
export function reconcileManualOrder(input: {
  readonly memberIds: readonly string[]
  readonly savedOrder: readonly string[] | undefined
  readonly summaries: Readonly<Record<string, SessionOrderSummary | undefined>>
  readonly pinnedIds: readonly string[]
}): string[] {
  const members = new Set(input.memberIds)
  const included = new Set<string>()
  const ordered: string[] = []
  for (const id of input.savedOrder ?? []) {
    if (!members.has(id) || included.has(id)) continue
    ordered.push(id)
    included.add(id)
  }
  const pins: string[] = []
  for (const id of input.pinnedIds) {
    if (!members.has(id) || included.has(id) || input.summaries[id] === undefined) continue
    pins.push(id)
    included.add(id)
  }
  const ordinary = orderByRecency(
    input.memberIds.filter((id) => !included.has(id)),
    input.summaries,
  )
  return [...pins, ...ordered, ...ordinary]
}

/**
 * 一次拖放产生的新顺序：source 从全量顺序中摘出，插到 target 前/后。
 * 非法输入或原地不动返回 null。调用方负责「同账号、同置顶块」的准入。
 */
export function reorderSession(input: {
  readonly order: readonly string[]
  readonly sourceId: string
  readonly targetId: string
  readonly half: 'before' | 'after'
}): readonly string[] | null {
  const { order, sourceId, targetId, half } = input
  if (sourceId === targetId) return null
  if (!order.includes(sourceId) || !order.includes(targetId)) return null
  const next = order.filter((id) => id !== sourceId)
  const targetIndex = next.indexOf(targetId)
  if (targetIndex === -1) return null
  next.splice(targetIndex + (half === 'after' ? 1 : 0), 0, sourceId)
  return next.every((id, index) => id === order[index]) ? null : next
}
