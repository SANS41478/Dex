import type { JsonValue, SettingsNamespace } from '@dexagent/shared'
import { useEffect, useState } from 'react'
import { type SettingsField, settingsFields } from '../../core/settings-form'
import { useSettingsStore } from '../../stores/settingsStore'

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return '未设置'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function SettingField({
  field,
  namespace,
  writable,
  saving,
}: {
  readonly field: SettingsField
  readonly namespace: SettingsNamespace
  readonly writable: boolean
  readonly saving: boolean
}) {
  const mutate = useSettingsStore((state) => state.mutate)
  const initial = displayValue(field.value)
  const [draft, setDraft] = useState(initial)
  const fieldId = `setting-${namespace.ns}-${field.path.join('-')}`

  useEffect(() => setDraft(initial), [initial])

  const write = (value: JsonValue): void => {
    void mutate({
      namespace: namespace.ns,
      operations: [{ op: 'set', path: [...field.path], value }],
      expectedRevision: namespace.revision,
    })
  }
  const saveDraft = (): void => {
    if (field.kind === 'string') write(draft)
    if (field.kind === 'number') {
      const value = Number(draft)
      if (draft.trim() !== '' && Number.isFinite(value)) write(value)
    }
  }

  return (
    <div className="global-settings-field">
      <label htmlFor={fieldId}>{field.label}</label>
      {field.kind === 'boolean' ? (
        <input
          id={fieldId}
          type="checkbox"
          checked={field.value === true}
          disabled={!writable || saving}
          onChange={(event) => write(event.currentTarget.checked)}
        />
      ) : field.kind === 'select' ? (
        <select
          id={fieldId}
          className="model-select"
          value={displayValue(field.value)}
          disabled={!writable || saving}
          onChange={(event) => {
            const selected = field.options?.find(
              (option) => displayValue(option) === event.currentTarget.value,
            )
            if (selected !== undefined) write(selected)
          }}
        >
          {field.options?.map((option) => (
            <option key={displayValue(option)} value={displayValue(option)}>
              {displayValue(option)}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' || field.kind === 'string' ? (
        <>
          <input
            id={fieldId}
            className="model-input"
            type={field.kind === 'number' ? 'number' : 'text'}
            value={draft === '未设置' ? '' : draft}
            disabled={!writable || saving}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveDraft()
            }}
          />
          <button
            type="button"
            className="graph-chip"
            disabled={!writable || saving || draft === initial}
            onClick={saveDraft}
          >
            保存
          </button>
        </>
      ) : (
        <span className="global-settings-readonly">{displayValue(field.value)}</span>
      )}
    </div>
  )
}

/** 单个设置命名空间的字段编辑器（「高级」页与「插件」页的配置折叠区共用）。 */
export function NamespaceEditor({ namespace }: { readonly namespace: SettingsNamespace }) {
  const writable = useSettingsStore((state) => state.data?.writable ?? false)
  const saving = useSettingsStore((state) => state.saving)
  const fields = settingsFields(namespace)

  if (fields.length === 0) {
    return <p className="muted">此设置分组没有可安全生成的字段。</p>
  }

  return (
    <div className="global-settings-fields">
      {fields.map((field) => (
        <SettingField
          key={`${namespace.ns}:${field.path.join('.')}`}
          field={field}
          namespace={namespace}
          writable={writable}
          saving={saving}
        />
      ))}
    </div>
  )
}

export function GlobalSettings() {
  const data = useSettingsStore((state) => state.data)
  const loadState = useSettingsStore((state) => state.loadState)
  const error = useSettingsStore((state) => state.error)
  const conflict = useSettingsStore((state) => state.conflict)
  const load = useSettingsStore((state) => state.load)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="settings-section" data-testid="global-settings">
      <h3 className="settings-section-title">dsh 全局设置</h3>
      {loadState === 'loading' && data === null ? (
        <p className="placeholder">正在读取设置…</p>
      ) : null}
      {error !== null ? <p className="model-error">{error}</p> : null}
      {conflict !== null ? <p className="placeholder">{conflict}</p> : null}
      {data !== null && !data.writable ? <p className="muted">当前配置为只读。</p> : null}
      {data?.namespaces.map((namespace) => (
        <details className="global-settings-namespace" key={namespace.ns}>
          <summary>{namespace.ns}</summary>
          <NamespaceEditor namespace={namespace} />
        </details>
      ))}
      {data !== null && data.namespaces.length === 0 ? (
        <p className="placeholder">当前 dsh profile 没有可编辑的全局设置分组。</p>
      ) : null}
      {loadState === 'error' && data === null ? (
        <button type="button" className="graph-chip" onClick={() => void load()}>
          重试读取
        </button>
      ) : null}
    </section>
  )
}
