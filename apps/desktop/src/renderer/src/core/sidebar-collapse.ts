/**
 * 侧栏「工作区分组」折叠状态的纯逻辑（key `dex.sidebar.collapsed.v1`）。
 *
 * 折叠态要持久化：会话一多，每次启动都全量展开会把侧栏撑成长卷轴。
 * 这里只管「哪些 key 被折起来了」——key 用工作区 id，天然稳定。
 */

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'dex.sidebar.collapsed.v1'

export function parseCollapsedIds(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item !== '')
  } catch {
    return []
  }
}

export function serializeCollapsedIds(ids: readonly string[]): string {
  return JSON.stringify([...ids])
}

/** 幂等切换：折起来 / 展开。返回新数组，不改入参。 */
export function toggleCollapsedId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

/** localStorage 可能不存在（纯 Node 单测环境）或写入失败（隐私模式），这里一律静默。 */
export function readCollapsedIds(): readonly string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return parseCollapsedIds(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY))
  } catch {
    return []
  }
}

export function writeCollapsedIds(ids: readonly string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, serializeCollapsedIds(ids))
  } catch {
    // 折叠态丢了只是回到全展开，不值得为它报错。
  }
}
