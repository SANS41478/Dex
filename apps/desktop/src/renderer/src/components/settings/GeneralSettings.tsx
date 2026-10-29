import type { SettingsNamespace } from '@dexagent/shared'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * 「通用」设置页（UI-09）：精选条目，照 dsh `settings.general.item` 的组织方式
 * （每个条目由具体能力拥有并说明自己的影响），而不是把 schema 全部摊开。
 *
 * 当前条目：默认权限档位、会话日志、终端超时与输出上限。
 * 原始命名空间（llm-pi-ai / agent-loop / subagent…）收进「高级」页。
 */

const PERMISSION_PRESETS = [
  { value: 'read-only', label: '只读' },
  { value: 'workspace-write', label: '工作区内修改' },
  { value: 'danger-full-access', label: '完全访问' },
] as const

function namespaceOf(
  namespaces: readonly SettingsNamespace[] | undefined,
  ns: string,
): SettingsNamespace | undefined {
  return namespaces?.find((item) => item.ns === ns)
}

function scalarAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function GeneralSettings() {
  const data = useSettingsStore((state) => state.data)
  const loadState = useSettingsStore((state) => state.loadState)
  const error = useSettingsStore((state) => state.error)
  const conflict = useSettingsStore((state) => state.conflict)
  const saving = useSettingsStore((state) => state.saving)
  const load = useSettingsStore((state) => state.load)
  const [notice, setNotice] = useState<string | null>(null)
  const [timeoutDraft, setTimeoutDraft] = useState('')
  const [outputDraft, setOutputDraft] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  const permission = namespaceOf(data?.namespaces, 'permission')
  const sessionLog = namespaceOf(data?.namespaces, 'session-log-deepseek')
  const sandbox = namespaceOf(data?.namespaces, 'pwsh-sandbox')
  const writable = data?.writable ?? false

  const timeoutValue = scalarAt(sandbox?.value, ['timeoutMs'])
  const outputValue = scalarAt(sandbox?.value, ['maxOutputBytes'])
  const timeoutText = typeof timeoutValue === 'number' ? String(timeoutValue) : ''
  const outputText = typeof outputValue === 'number' ? String(outputValue) : ''
  useEffect(() => setTimeoutDraft(timeoutText), [timeoutText])
  useEffect(() => setOutputDraft(outputText), [outputText])

  const write = async (
    namespace: SettingsNamespace,
    path: string[],
    value: number | string | boolean,
  ): Promise<void> => {
    setNotice(null)
    await useSettingsStore.getState().mutate({
      namespace: namespace.ns,
      operations: [{ op: 'set', path, value }],
      expectedRevision: namespace.revision,
    })
    setNotice('已保存')
  }

  if (loadState === 'loading' && data === null) {
    return <p className="placeholder">正在读取设置…</p>
  }
  if (error !== null && data === null) {
    return (
      <>
        <p className="model-error">{error}</p>
        <button type="button" className="graph-chip" onClick={() => void load()}>
          重试读取
        </button>
      </>
    )
  }
  if (data === null) return <p className="placeholder">暂无设置。</p>

  return (
    <div className="general-settings" data-testid="general-settings">
      {!writable ? <p className="muted">当前配置为只读。</p> : null}
      {conflict !== null ? <p className="placeholder">{conflict}</p> : null}
      {notice !== null ? <p className="muted">{notice}</p> : null}

      {permission !== undefined ? (
        <section className="settings-section">
          <h3 className="settings-section-title">默认权限档位</h3>
          <p className="muted">
            新会话默认使用的权限档位。当前 runtime 实际支持「工作区内修改」；选择其他档位时会被
            降级执行并给出提示。
          </p>
          <select
            className="model-select"
            value={
              typeof scalarAt(permission.value, ['defaultPreset']) === 'string'
                ? String(scalarAt(permission.value, ['defaultPreset']))
                : ''
            }
            disabled={!writable || saving}
            onChange={(event) => {
              void write(permission, ['defaultPreset'], event.currentTarget.value)
            }}
            data-testid="default-permission-selector"
          >
            {PERMISSION_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}（{preset.value}）
              </option>
            ))}
          </select>
        </section>
      ) : null}

      {sessionLog !== undefined ? (
        <section className="settings-section">
          <h3 className="settings-section-title">会话日志</h3>
          <p className="muted">是否把会话事件写入 DeepSeek 会话日志（关闭后新会话不再记录）。</p>
          <label className="settings-inline">
            <input
              type="checkbox"
              checked={scalarAt(sessionLog.value, ['enabled']) === true}
              disabled={!writable || saving}
              onChange={(event) => {
                void write(sessionLog, ['enabled'], event.currentTarget.checked)
              }}
              data-testid="session-log-enabled"
            />
            <span>启用会话日志</span>
          </label>
        </section>
      ) : null}

      {sandbox !== undefined ? (
        <section className="settings-section">
          <h3 className="settings-section-title">终端</h3>
          <p className="muted">
            限制每条命令最多能跑多久、最多输出多少内容（超出部分转存临时文件）。
          </p>
          <div className="general-settings-row">
            <label className="model-field">
              <span className="muted">命令超时（毫秒）</span>
              <input
                className="model-input"
                type="number"
                value={timeoutDraft}
                disabled={!writable || saving}
                onChange={(event) => setTimeoutDraft(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="graph-chip"
              disabled={!writable || saving || timeoutDraft === timeoutText}
              onClick={() => {
                const value = Number(timeoutDraft)
                if (Number.isFinite(value) && value > 0) {
                  void write(sandbox, ['timeoutMs'], value)
                }
              }}
              data-testid="sandbox-timeout-save"
            >
              保存
            </button>
            <label className="model-field">
              <span className="muted">单流输出上限（字节）</span>
              <input
                className="model-input"
                type="number"
                value={outputDraft}
                disabled={!writable || saving}
                onChange={(event) => setOutputDraft(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="graph-chip"
              disabled={!writable || saving || outputDraft === outputText}
              onClick={() => {
                const value = Number(outputDraft)
                if (Number.isFinite(value) && value > 0) {
                  void write(sandbox, ['maxOutputBytes'], value)
                }
              }}
              data-testid="sandbox-output-save"
            >
              保存
            </button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
