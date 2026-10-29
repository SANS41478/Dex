import type { PluginInfo } from '@dexagent/shared'

/** 插件行在界面上的四态（由启用状态 + fiber 相位推导）。 */
export type PluginRowStatus = 'failed' | 'active' | 'pending' | 'disabled'

export type PluginStatusFilter = 'all' | 'enabled' | 'disabled' | 'failed'

/**
 * 行状态优先级：失败 > 禁用 > 相位。
 *
 * 失败优先于禁用：一个 enabled 的条目如果 fiber 失败，用户最需要看到的是「失败」，
 * 而不是被「已启用」掩盖（disabled 条目没有 fiber，不会走进失败分支）。
 */
export function pluginRowStatus(plugin: PluginInfo): PluginRowStatus {
  if (plugin.fiberPhase === 'failed') return 'failed'
  if (!plugin.enabled) return 'disabled'
  return plugin.fiberPhase === 'active' ? 'active' : 'pending'
}

export function pluginStatusLabel(status: PluginRowStatus): string {
  if (status === 'failed') return '失败'
  if (status === 'active') return '已启用'
  if (status === 'pending') return '启动中'
  return '已禁用'
}

export function pluginReadOnlyLabel(reason: 'management-required' | 'unaddressable'): string {
  return reason === 'management-required'
    ? '管理链路插件：应用内不可启停'
    : '嵌套组合提供：应用内不可启停'
}

/**
 * 条目 id → 设置命名空间：settings 的 `ns` 是组合行 id（如 `llm-pi-ai`），
 * Loader 条目 id 带 `include:` 前缀；嵌套时取最后一段。
 */
export function settingsNamespaceKey(
  entryId: string,
  namespaces: readonly { readonly ns: string }[],
): string | null {
  if (namespaces.some((namespace) => namespace.ns === entryId)) return entryId
  const tail = entryId.split(':').at(-1)
  if (tail !== undefined && tail !== '' && namespaces.some((namespace) => namespace.ns === tail)) {
    return tail
  }
  return null
}

export interface PluginCounts {
  readonly total: number
  readonly enabled: number
  readonly disabled: number
  readonly failed: number
}

export function countPlugins(plugins: readonly PluginInfo[]): PluginCounts {
  let enabled = 0
  let disabled = 0
  let failed = 0
  for (const plugin of plugins) {
    const status = pluginRowStatus(plugin)
    if (status === 'failed') failed += 1
    else if (status === 'disabled') disabled += 1
    else enabled += 1
  }
  return { total: plugins.length, enabled, disabled, failed }
}

function matchesFilter(plugin: PluginInfo, filter: PluginStatusFilter): boolean {
  if (filter === 'all') return true
  const status = pluginRowStatus(plugin)
  if (filter === 'failed') return status === 'failed'
  if (filter === 'disabled') return status === 'disabled'
  return status === 'active' || status === 'pending'
}

function matchesQuery(plugin: PluginInfo, query: string): boolean {
  if (query === '') return true
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return [plugin.title, plugin.description, plugin.moduleName, plugin.entryId].some((field) =>
    field?.toLowerCase().includes(needle),
  )
}

const STATUS_RANK: Record<PluginRowStatus, number> = {
  failed: 0,
  active: 1,
  pending: 2,
  disabled: 3,
}

/** 搜索 + 状态筛选 + 排序（失败最前，其后按模块名/条目 id 稳定排序）。 */
export function filterAndSortPlugins(
  plugins: readonly PluginInfo[],
  query: string,
  filter: PluginStatusFilter,
): PluginInfo[] {
  return plugins
    .filter((plugin) => matchesFilter(plugin, filter) && matchesQuery(plugin, query))
    .sort((left, right) => {
      const rank = STATUS_RANK[pluginRowStatus(left)] - STATUS_RANK[pluginRowStatus(right)]
      if (rank !== 0) return rank
      const byModule = left.moduleName.localeCompare(right.moduleName)
      return byModule !== 0 ? byModule : left.entryId.localeCompare(right.entryId)
    })
}
