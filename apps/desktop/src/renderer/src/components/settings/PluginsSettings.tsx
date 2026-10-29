import type { PluginBundleInfo, PluginInfo } from '@dexagent/shared'
import { useEffect, useMemo, useState } from 'react'
import {
  countPlugins,
  filterAndSortPlugins,
  type PluginStatusFilter,
  pluginReadOnlyLabel,
  pluginRowStatus,
  pluginStatusLabel,
  settingsNamespaceKey,
} from '../../core/plugins'
import { usePluginStore } from '../../stores/pluginStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { NamespaceEditor } from './GlobalSettings'

const FILTERS: readonly { readonly id: PluginStatusFilter; readonly label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已禁用' },
  { id: 'failed', label: '失败' },
]

function bundleNote(bundle: PluginBundleInfo): string | null {
  if (bundle.errorCode !== undefined) return `加载问题：${bundle.errorCode}`
  if (bundle.readOnlyReason !== undefined) {
    return bundle.readOnlyReason === 'management-required' ? '受保护（管理链路）' : '不可寻址'
  }
  return null
}

function resultMessage(
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled',
  enabled: boolean | undefined,
): string {
  const action = enabled === false ? '禁用' : '启用'
  if (application === 'applied') return `已${action}并即时生效。`
  if (application === 'restart-required') return `已写入配置；重启应用后生效。`
  if (application === 'overridden')
    return `已写入配置，但该行由更高层补丁提供（应用内置），实际状态未变。`
  if (application === 'cancelled') return '操作已取消。'
  return `${action}失败。`
}

/**
 * 「插件」设置页（UI-10）：dsh 插件管理服务在 Dex 内的唯一入口。
 *
 * - 列表/启停：宿主 `pluginManager`（官方插件管理 UI 同源）；开关写 profile 的
 *   `cordis.patch.yml`，HMR 在线即时生效。
 * - 配置：该行若有设置命名空间，就地展开官方 volatile 字段编辑器（复用「高级」页表单）。
 * - bundle 列表只读展示（安装/卸载不在本期范围）。
 */
export function PluginsSettings() {
  const data = usePluginStore((state) => state.data)
  const loadState = usePluginStore((state) => state.loadState)
  const error = usePluginStore((state) => state.error)
  const actionEntryId = usePluginStore((state) => state.actionEntryId)
  const actionResult = usePluginStore((state) => state.actionResult)
  const actionError = usePluginStore((state) => state.actionError)
  const load = usePluginStore((state) => state.load)
  const setEnabled = usePluginStore((state) => state.setEnabled)
  const clearAction = usePluginStore((state) => state.clearAction)

  const settingsData = useSettingsStore((state) => state.data)
  const loadSettings = useSettingsStore((state) => state.load)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginStatusFilter>('all')
  const [confirming, setConfirming] = useState<PluginInfo | null>(null)

  useEffect(() => {
    void load()
    void loadSettings()
  }, [load, loadSettings])

  const plugins = useMemo(
    () => filterAndSortPlugins(data?.plugins ?? [], query, filter),
    [data, query, filter],
  )
  const counts = useMemo(() => countPlugins(data?.plugins ?? []), [data])

  const confirmDisable = async (): Promise<void> => {
    if (confirming === null) return
    await setEnabled({ entryId: confirming.entryId, enabled: false })
    setConfirming(null)
  }

  return (
    <section className="settings-section plugins-settings" data-testid="plugins-settings">
      <h3 className="settings-section-title">插件</h3>
      <p className="muted">启停写入 profile 的 cordis.patch.yml；配置使用插件自身的设置字段。</p>
      {data !== null && !data.hmrAvailable ? (
        <p className="muted">宿主 HMR 不可用：变更需要重启应用后生效。</p>
      ) : null}
      {data !== null && !data.managementAvailable ? (
        <p className="muted">插件管理服务不可用：当前为只读清单。</p>
      ) : null}
      {actionResult !== null ? (
        <p className="muted" data-testid="plugins-action-result">
          {resultMessage(actionResult.application, actionResult.enabled)}
        </p>
      ) : null}
      {actionError !== null ? (
        <p className="model-error" data-testid="plugins-action-error">
          {actionError.message}
        </p>
      ) : null}

      <div className="plugins-toolbar">
        <input
          className="model-input plugins-search"
          type="search"
          value={query}
          placeholder="搜索插件（名称 / 模块 / 条目 id）"
          aria-label="搜索插件"
          data-testid="plugins-search"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <span className="graph-chips">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`graph-chip${filter === item.id ? ' graph-chip-active' : ''}`}
              data-testid={`plugins-filter-${item.id}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </span>
      </div>
      <p className="muted" data-testid="plugins-counts">
        共 {counts.total} 个插件 · 已启用 {counts.enabled} · 已禁用 {counts.disabled} · 失败{' '}
        {counts.failed}
      </p>

      {loadState === 'loading' && data === null ? (
        <p className="placeholder">正在读取插件列表…</p>
      ) : null}
      {error !== null && data === null ? <p className="model-error">{error}</p> : null}
      {loadState === 'error' && data === null ? (
        <button type="button" className="graph-chip" onClick={() => void load()}>
          重试读取
        </button>
      ) : null}

      {data !== null ? (
        <ul className="settings-list" data-testid="plugins-list">
          {plugins.map((plugin) => {
            const status = pluginRowStatus(plugin)
            const namespaceKey = settingsNamespaceKey(
              plugin.entryId,
              settingsData?.namespaces ?? [],
            )
            const namespace =
              namespaceKey === null
                ? undefined
                : settingsData?.namespaces.find((item) => item.ns === namespaceKey)
            const busy = actionEntryId === plugin.entryId
            return (
              <li
                key={plugin.entryId}
                className="settings-list-item settings-list-item-static plugin-row"
                data-testid={`plugin-row-${plugin.entryId}`}
              >
                <div className="plugin-row-main">
                  <div className="plugin-row-head">
                    <span className="plugin-row-title">{plugin.title ?? plugin.moduleName}</span>
                    <span
                      className={`plugin-badge plugin-badge-${status}`}
                      data-testid={`plugin-status-${plugin.entryId}`}
                    >
                      {pluginStatusLabel(status)}
                    </span>
                    {plugin.readOnlyReason !== undefined ? (
                      <span className="muted">{pluginReadOnlyLabel(plugin.readOnlyReason)}</span>
                    ) : null}
                  </div>
                  {plugin.description !== undefined ? (
                    <span className="muted">{plugin.description}</span>
                  ) : null}
                  <span className="workspace-path mono">{plugin.moduleName}</span>
                  {plugin.hasSettings ? (
                    <details className="global-settings-namespace plugin-config">
                      <summary>配置</summary>
                      {namespace === undefined ? (
                        <p className="muted">正在读取该插件的设置字段…</p>
                      ) : (
                        <NamespaceEditor namespace={namespace} />
                      )}
                    </details>
                  ) : null}
                </div>
                <div className="plugin-row-actions">
                  {data.managementAvailable && plugin.patchId !== undefined ? (
                    <label className="plugin-switch">
                      <input
                        type="checkbox"
                        checked={plugin.enabled}
                        disabled={busy}
                        aria-label={`${plugin.enabled ? '禁用' : '启用'} ${plugin.title ?? plugin.moduleName}`}
                        data-testid={`plugin-toggle-${plugin.entryId}`}
                        onChange={(event) => {
                          clearAction()
                          if (event.currentTarget.checked) {
                            void setEnabled({ entryId: plugin.entryId, enabled: true })
                          } else {
                            setConfirming(plugin)
                          }
                        }}
                      />
                      <span className="muted">
                        {busy ? '处理中…' : plugin.enabled ? '已启用' : '已禁用'}
                      </span>
                    </label>
                  ) : (
                    <span className="muted">
                      {plugin.patchId === undefined && plugin.readOnlyReason === undefined
                        ? '只读'
                        : ''}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      {data !== null && plugins.length === 0 ? (
        <p className="placeholder">没有匹配的插件。</p>
      ) : null}

      {data !== null && data.bundles.length > 0 ? (
        <section className="settings-section" data-testid="plugins-bundles">
          <h3 className="settings-section-title">插件包（bundle）</h3>
          <p className="muted">bundle 由 profile 装配声明；安装/卸载不在当前版本范围。</p>
          <ul className="settings-list">
            {data.bundles.map((bundle) => (
              <li key={bundle.name} className="settings-list-item settings-list-item-static">
                <span className="session-row-main">
                  <span className="session-row-title">
                    {bundle.name}
                    {bundle.version !== undefined ? ` v${bundle.version}` : ''}
                  </span>
                  {bundle.description !== undefined ? (
                    <span className="muted">{bundle.description}</span>
                  ) : null}
                </span>
                <span className="muted">
                  {bundle.enabled ? '已启用' : '未启用'}
                  {bundleNote(bundle) !== null ? ` · ${bundleNote(bundle)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {confirming !== null ? (
        <ConfirmDialog
          title="禁用插件？"
          description={`将把「${confirming.title ?? confirming.moduleName}」写为禁用；相关能力可能立即不可用（可在本页重新启用）。`}
          confirmLabel="确认禁用"
          danger
          onClose={() => setConfirming(null)}
          onConfirm={confirmDisable}
        />
      ) : null}
    </section>
  )
}
