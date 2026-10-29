import type { PluginInfo } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import {
  countPlugins,
  filterAndSortPlugins,
  pluginReadOnlyLabel,
  pluginRowStatus,
  pluginStatusLabel,
  settingsNamespaceKey,
} from './plugins'

function make(overrides: Partial<PluginInfo> & Pick<PluginInfo, 'entryId'>): PluginInfo {
  return {
    moduleName: '@deepseek-ai/dsh-sample',
    enabled: true,
    fiberPhase: 'active',
    hasSettings: false,
    ...overrides,
  }
}

describe('pluginRowStatus', () => {
  it('失败优先于启用：enabled 但 fiber failed 的行显示「失败」', () => {
    expect(pluginRowStatus(make({ entryId: 'a', fiberPhase: 'failed' }))).toBe('failed')
  })

  it('未启用 → 已禁用；已启用未激活 → 启动中', () => {
    expect(pluginRowStatus(make({ entryId: 'a', enabled: false, fiberPhase: null }))).toBe(
      'disabled',
    )
    expect(pluginRowStatus(make({ entryId: 'a', fiberPhase: 'pending' }))).toBe('pending')
    expect(pluginRowStatus(make({ entryId: 'a', fiberPhase: null }))).toBe('pending')
  })

  it('标签覆盖四态', () => {
    expect(pluginStatusLabel('failed')).toBe('失败')
    expect(pluginStatusLabel('active')).toBe('已启用')
    expect(pluginStatusLabel('pending')).toBe('启动中')
    expect(pluginStatusLabel('disabled')).toBe('已禁用')
  })

  it('只读原因分两类人话', () => {
    expect(pluginReadOnlyLabel('management-required')).toContain('管理链路')
    expect(pluginReadOnlyLabel('unaddressable')).toContain('嵌套组合')
  })
})

describe('filterAndSortPlugins', () => {
  const plugins: PluginInfo[] = [
    make({ entryId: 'include:beta', moduleName: '@deepseek-ai/dsh-beta' }),
    make({
      entryId: 'include:alpha',
      moduleName: '@deepseek-ai/dsh-alpha',
      enabled: false,
      fiberPhase: null,
    }),
    make({ entryId: 'include:gamma', moduleName: '@deepseek-ai/dsh-gamma', fiberPhase: 'failed' }),
    make({ entryId: 'include:trace', moduleName: '@dexagent/dex-trace-bridge' }),
  ]

  it('失败最前，其后启用、启动中、禁用；组内按模块名排序', () => {
    const sorted = filterAndSortPlugins(plugins, '', 'all')
    expect(sorted.map((plugin) => plugin.entryId)).toEqual([
      'include:gamma',
      'include:beta',
      'include:trace',
      'include:alpha',
    ])
  })

  it('筛选：enabled 不含失败与禁用；failed / disabled 各取一态', () => {
    expect(filterAndSortPlugins(plugins, '', 'enabled').map((p) => p.entryId)).toEqual([
      'include:beta',
      'include:trace',
    ])
    expect(filterAndSortPlugins(plugins, '', 'failed').map((p) => p.entryId)).toEqual([
      'include:gamma',
    ])
    expect(filterAndSortPlugins(plugins, '', 'disabled').map((p) => p.entryId)).toEqual([
      'include:alpha',
    ])
  })

  it('搜索命中标题/描述/模块名/条目 id，大小写不敏感', () => {
    expect(filterAndSortPlugins(plugins, 'TRACE', 'all').map((p) => p.entryId)).toEqual([
      'include:trace',
    ])
    expect(filterAndSortPlugins(plugins, 'beta', 'all')).toHaveLength(1)
    expect(
      filterAndSortPlugins(
        [make({ entryId: 'a', title: '会话日志', description: 'Session log' })],
        '会话',
        'all',
      ),
    ).toHaveLength(1)
  })

  it('countPlugins 统计四态（pending 计入 enabled）', () => {
    expect(countPlugins(plugins)).toEqual({ total: 4, enabled: 2, disabled: 1, failed: 1 })
  })
})

describe('settingsNamespaceKey', () => {
  const namespaces = [{ ns: 'llm-pi-ai' }, { ns: 'pwsh-sandbox' }]

  it('去掉 include: 前缀后命中设置命名空间', () => {
    expect(settingsNamespaceKey('include:llm-pi-ai', namespaces)).toBe('llm-pi-ai')
  })

  it('原样命中与未命中', () => {
    expect(settingsNamespaceKey('pwsh-sandbox', namespaces)).toBe('pwsh-sandbox')
    expect(settingsNamespaceKey('include:dex-graph-bridge', namespaces)).toBeNull()
  })
})
