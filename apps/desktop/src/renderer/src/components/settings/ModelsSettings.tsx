import type { JsonValue, SettingsNamespace } from '@dexagent/shared'
import { useMemo, useState } from 'react'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * 「模型」设置页（UI-09，照 dsh `ui-settings-models` 的信息架构自建）。
 *
 * 权威分工：
 * - **provider 目录**来自宿主 `llm.listConfigurableProviders()`（含未生效路由）；
 * - **provider 配置**读写 `llm-pi-ai` 设置的 user 层（`providers.<route>`，volatile）；
 * - **凭据**走 `credentials/set|unset`（ref 名照官方派生规则 `<ROUTE>_API_KEY`）；
 * - **全局默认模型**读写 `agent-default-model`（provider/model，volatile）。
 *
 * 本页替代了原先挂在设置里的会话级 `ModelControl`：会话级模型选择仍由 Composer 承担，
 * 设置页只做全局配置（dsh 的 UI 分工亦如此）。
 */

type UnknownRecord = Record<string, unknown>

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

/** 官方派生规则（`ui-settings-models` 的 `deriveKeyRef`）。 */
export function deriveKeyRef(provider: string): string {
  return `${provider.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`
}

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

interface ProviderCard {
  readonly provider: string
  readonly displayName: string
  readonly live: boolean
  readonly declared: boolean
  readonly error?: string
  readonly credentialConfigured: boolean | undefined
  readonly removable: boolean
  readonly profile: UnknownRecord | undefined
  readonly settingsPath: readonly string[]
  /** 该 provider 配置所在的设置命名空间（整段式 provider 的 `settingsPath` 为空）。 */
  readonly settingsNs: string
}

/**
 * 按 id 合并模型条目：保留原对象上的扩展字段（`reasoningEfforts` / `contextWindow` /
 * `inputModalities` 等），行编辑器只负责增删与改名。
 *
 * 为什么必须这么做：行编辑器只有 `id|名称` 两列，重建时若直接产出 `{id,name}`，
 * 编辑 rings 这类声明了推理档位的路由会把 `reasoningEfforts` 悄悄删掉（档位断链）。
 */
function mergeModelsById(
  parsed: readonly { id: string; name: string }[],
  original: unknown,
): { [key: string]: JsonValue }[] {
  const byId = new Map<string, UnknownRecord>()
  if (Array.isArray(original)) {
    for (const entry of original) {
      const record = recordOf(entry)
      if (record !== null && typeof record.id === 'string') byId.set(record.id, record)
    }
  }
  return parsed.map((model) => {
    const existing = byId.get(model.id)
    const base = existing === undefined ? {} : (recordJson(existing) ?? {})
    return { ...base, id: model.id, name: model.name }
  })
}

function modelLines(models: unknown): string {
  if (!Array.isArray(models)) return ''
  return models
    .flatMap((entry) => {
      const record = recordOf(entry)
      const id = record?.id
      if (typeof id !== 'string') return []
      const name = record?.name
      return [typeof name === 'string' && name !== '' && name !== id ? `${id}|${name}` : id]
    })
    .join('\n')
}

function parseModelLines(text: string): { id: string; name: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [id, name] = line.split('|').map((part) => part.trim())
      return { id: id ?? '', name: name === undefined || name === '' ? (id ?? '') : name }
    })
}

export function ModelsSettings() {
  const catalog = useModelStore((state) => state.catalog)
  const catalogState = useModelStore((state) => state.loadState)
  const catalogError = useModelStore((state) => state.error)
  const settingsData = useSettingsStore((state) => state.data)
  const settingsState = useSettingsStore((state) => state.loadState)
  const settingsError = useSettingsStore((state) => state.error)
  const conflict = useSettingsStore((state) => state.conflict)
  const saving = useSettingsStore((state) => state.saving)

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<'catalog' | 'custom'>('catalog')
  const [catalogPick, setCatalogPick] = useState('')
  const [catalogKey, setCatalogKey] = useState('')
  const [customRoute, setCustomRoute] = useState('')
  const [customName, setCustomName] = useState('')
  const [customApi, setCustomApi] = useState<(typeof API_PROTOCOLS)[number]>('openai-completions')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModels, setCustomModels] = useState('')
  const [customKey, setCustomKey] = useState('')

  const [editing, setEditing] = useState<ProviderCard | null>(null)
  const [editName, setEditName] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')
  const [editApi, setEditApi] = useState<(typeof API_PROTOCOLS)[number]>('openai-completions')
  const [editModels, setEditModels] = useState('')
  const [editKey, setEditKey] = useState('')
  /** 行内填写密钥（不用原生 prompt：Electron 不支持）。 */
  const [keyEditor, setKeyEditor] = useState<{ provider: string; value: string } | null>(null)
  /** 整段式 provider（settingsPath 为空）的模型目录编辑器。 */
  const [editingCatalog, setEditingCatalog] = useState<{
    readonly card: ProviderCard
    readonly namespace: SettingsNamespace
  } | null>(null)
  const [catalogLines, setCatalogLines] = useState('')

  const piAi = settingsData?.namespaces.find((namespace) => namespace.ns === 'llm-pi-ai')
  const defaultNs = settingsData?.namespaces.find(
    (namespace) => namespace.ns === 'agent-default-model',
  )
  const userProviders = useMemo(() => {
    const user = recordOf(piAi?.user)
    return recordOf(user?.providers) ?? {}
  }, [piAi])

  const cards = useMemo<ProviderCard[]>(() => {
    const byProvider = new Map<string, ProviderCard>()
    for (const entry of catalog.configurable) {
      const profile = recordOf(userProviders[entry.provider]) ?? undefined
      const live = catalog.providers.find((provider) => provider.id === entry.provider)
      byProvider.set(entry.provider, {
        provider: entry.provider,
        displayName: entry.displayName,
        live: entry.live,
        declared: entry.declared === true,
        ...(entry.error === undefined ? {} : { error: entry.error }),
        credentialConfigured: live?.credential.configured,
        removable: profile !== undefined,
        profile,
        settingsPath: entry.settingsPath,
        settingsNs: entry.settingsNs,
      })
    }
    for (const provider of catalog.providers) {
      if (byProvider.has(provider.id)) continue
      byProvider.set(provider.id, {
        provider: provider.id,
        displayName: provider.name,
        live: true,
        declared: false,
        credentialConfigured: provider.credential.configured,
        removable: false,
        profile: undefined,
        settingsPath: [],
        settingsNs: 'llm-pi-ai',
      })
    }
    return [...byProvider.values()].sort((left, right) => {
      if (left.live !== right.live) return left.live ? -1 : 1
      if (left.declared !== right.declared) return left.declared ? -1 : 1
      return left.provider.localeCompare(right.provider)
    })
  }, [catalog, userProviders])

  const catalogCandidates = useMemo(
    () =>
      cards.filter(
        (card) => !card.declared && !card.live && !card.removable && card.error === undefined,
      ),
    [cards],
  )
  const defaultOptions = useMemo(
    () =>
      catalog.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          value: `${provider.id}/${model.id}`,
          label: `${provider.name} · ${model.name}`,
        })),
      ),
    [catalog],
  )
  const currentDefault = catalog.defaultSelection

  const refresh = async (): Promise<void> => {
    await Promise.all([useModelStore.getState().load(), useSettingsStore.getState().load()])
  }

  const run = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label}失败`)
      return false
    } finally {
      setBusy(false)
    }
  }

  type ProviderPathOperation =
    | { op: 'set'; path: string[]; value: JsonValue }
    | { op: 'unset'; path: string[] }
  const writeNamespace = async (
    namespace: SettingsNamespace | undefined,
    operations: ProviderPathOperation[],
  ): Promise<void> => {
    if (namespace === undefined) throw new Error('设置分组不可用')
    await useSettingsStore.getState().mutate({
      namespace: namespace.ns,
      operations,
      expectedRevision: namespace.revision,
    })
  }
  const writeProviders = (operations: ProviderPathOperation[]): Promise<void> =>
    writeNamespace(piAi, operations)

  /** 取命名空间里生效的模型数组（value → base → user 依次回退）。 */
  const modelsOf = (namespace: SettingsNamespace | undefined): unknown[] => {
    if (namespace === undefined) return []
    for (const layer of [namespace.value, namespace.base, namespace.user]) {
      const models = recordOf(layer)?.models
      if (Array.isArray(models)) return models
    }
    return []
  }
  /**
   * 整段式 provider（如 `deepseek-official` → `llm-deepseek`）的模型目录编辑入口：
   * 条件 = 目录项 settingsPath 为空且该命名空间存在 `models` 数组（volatile，可写）。
   */
  const modelsNamespaceOf = (card: ProviderCard): SettingsNamespace | undefined => {
    if (card.settingsPath.length !== 0) return undefined
    const namespace = settingsData?.namespaces.find((item) => item.ns === card.settingsNs)
    if (namespace === undefined) return undefined
    const hasModels = [namespace.value, namespace.base, namespace.user].some((layer) =>
      Array.isArray(recordOf(layer)?.models),
    )
    return hasModels ? namespace : undefined
  }

  const selectDefault = async (value: string): Promise<void> => {
    const [provider, model] = value.split('/')
    if (provider === undefined || model === undefined || defaultNs === undefined) return
    await run('保存默认模型', async () => {
      await useSettingsStore.getState().mutate({
        namespace: 'agent-default-model',
        operations: [
          { op: 'set', path: ['provider'], value: provider },
          { op: 'set', path: ['model'], value: model },
        ],
        expectedRevision: defaultNs.revision,
      })
      await refresh()
      setNotice('默认模型已保存（新会话与未指定模型的恢复使用它）')
    })
  }

  const saveCredential = async (provider: string, key: string): Promise<boolean> =>
    run('保存凭据', async () => {
      if (key.trim() === '') throw new Error('请输入 API 密钥')
      await unwrapControl(window.dex.models.setCredential(provider, key.trim()))
      setNotice(`${provider} 的凭据已保存`)
      await refresh()
    })

  const clearCredential = async (provider: string): Promise<void> => {
    await run('清除凭据', async () => {
      await unwrapControl(window.dex.models.unsetCredential(provider))
      setNotice(`${provider} 的凭据已清除`)
      await refresh()
    })
  }

  const addCatalogProvider = async (): Promise<void> => {
    const route = catalogPick
    if (route === '') throw new Error('请选择提供商')
    const keyRef = deriveKeyRef(route)
    await writeProviders([{ op: 'set', path: ['providers', route, 'apiKeyEnv'], value: keyRef }])
    if (catalogKey.trim() !== '') {
      await unwrapControl(window.dex.models.setCredential(route, catalogKey.trim()))
    }
    await refresh()
  }

  const addCustomProvider = async (): Promise<void> => {
    if (!ROUTE_PATTERN.test(customRoute)) {
      throw new Error('Provider ID 需以小写字母开头，只能含小写字母、数字与短横线')
    }
    const models = parseModelLines(customModels)
    if (models.length === 0) throw new Error('至少需要一个模型（每行一个，可写 id|显示名）')
    const keyRef = customKey.trim() === '' ? undefined : deriveKeyRef(customRoute)
    const profile: { [key: string]: JsonValue } = {
      displayName: customName.trim() === '' ? customRoute : customName.trim(),
      api: customApi,
      baseURL: customBaseUrl.trim(),
      models: models.map((model) => ({ id: model.id, name: model.name })),
      ...(keyRef === undefined ? {} : { apiKeyEnv: keyRef }),
    }
    if (customBaseUrl.trim() === '') throw new Error('自定义提供商需要 API 地址')
    await writeProviders([{ op: 'set', path: ['providers', customRoute], value: profile }])
    if (keyRef !== undefined) {
      await unwrapControl(window.dex.models.setCredential(customRoute, customKey.trim()))
    }
    await refresh()
  }

  const saveEditing = async (): Promise<void> => {
    if (editing === null) return
    const models = parseModelLines(editModels)
    if (models.length === 0) throw new Error('至少需要一个模型')
    const profile: { [key: string]: JsonValue } = {
      ...(recordJson(editing.profile) ?? {}),
      displayName: editName.trim() === '' ? editing.provider : editName.trim(),
      baseURL: editBaseUrl.trim(),
      // 逐 id 合并：保留 `reasoningEfforts` 等模型级扩展字段（UI-09 收口修复）。
      models: mergeModelsById(models, editing.profile?.models),
      ...(editing.declared ? { api: editApi } : {}),
    }
    await writeProviders([{ op: 'set', path: ['providers', editing.provider], value: profile }])
    if (editKey.trim() !== '') {
      await unwrapControl(window.dex.models.setCredential(editing.provider, editKey.trim()))
    }
    await refresh()
  }

  const openCatalogEditor = (card: ProviderCard): void => {
    const namespace = modelsNamespaceOf(card)
    if (namespace === undefined) return
    setEditingCatalog({ card, namespace })
    setCatalogLines(modelLines(modelsOf(namespace)))
    setError(null)
    setNotice(null)
  }

  const saveCatalogModels = async (): Promise<void> => {
    if (editingCatalog === null) return
    const parsed = parseModelLines(catalogLines)
    if (parsed.length === 0) throw new Error('至少保留一个模型')
    await writeNamespace(editingCatalog.namespace, [
      {
        op: 'set',
        path: ['models'],
        value: mergeModelsById(parsed, modelsOf(editingCatalog.namespace)),
      },
    ])
    await refresh()
  }

  /** 清掉 user 层对 `models` 的覆盖（回到适配器默认模型目录）。 */
  const resetCatalogModels = async (): Promise<void> => {
    if (editingCatalog === null) return
    await writeNamespace(editingCatalog.namespace, [{ op: 'unset', path: ['models'] }])
    await refresh()
  }

  const removeProvider = async (card: ProviderCard): Promise<void> => {
    await run('删除提供商', async () => {
      const apiKeyEnv = card.profile?.apiKeyEnv
      // 官方规则：只有「页面自己派生并管理」的 key 才随配置一起清除，其余凭据保留。
      if (
        typeof apiKeyEnv === 'string' &&
        apiKeyEnv === deriveKeyRef(card.provider) &&
        card.credentialConfigured === true
      ) {
        await unwrapControl(window.dex.models.unsetCredential(card.provider))
      }
      await writeProviders([{ op: 'unset', path: ['providers', card.provider] }])
      setNotice(`已删除 ${card.displayName} 的配置`)
      await refresh()
    })
  }

  const fetchModels = async (input: {
    namespace: string
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
    apply: (lines: string) => void
  }): Promise<void> => {
    await run('拉取模型', async () => {
      const raw = await window.dex.models.discover({
        namespace: input.namespace,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.baseURL === undefined || input.baseURL.trim() === ''
          ? {}
          : { baseURL: input.baseURL.trim() }),
        ...(input.api === undefined ? {} : { api: input.api }),
        ...(input.apiKey === undefined || input.apiKey.trim() === ''
          ? {}
          : { apiKey: input.apiKey.trim() }),
      })
      const models = unwrapControl(raw) as readonly { id: string; name?: string }[]
      if (models.length === 0) throw new Error('提供商没有返回可用模型')
      input.apply(models.map((model) => `${model.id}|${model.name ?? model.id}`).join('\n'))
      setNotice(`已拉取 ${String(models.length)} 个模型，确认后保存`)
    })
  }

  const openEditor = (card: ProviderCard): void => {
    const profile = recordOf(card.profile)
    setEditing(card)
    setEditName(typeof profile?.displayName === 'string' ? profile.displayName : card.displayName)
    setEditBaseUrl(typeof profile?.baseURL === 'string' ? profile.baseURL : '')
    setEditApi(
      typeof profile?.api === 'string' && (API_PROTOCOLS as readonly string[]).includes(profile.api)
        ? (profile.api as (typeof API_PROTOCOLS)[number])
        : 'openai-completions',
    )
    setEditModels(modelLines(profile?.models))
    setEditKey('')
    setError(null)
    setNotice(null)
  }

  if (settingsState === 'loading' && settingsData === null) {
    return <p className="placeholder">正在读取 dsh 设置…</p>
  }
  if (settingsError !== null) {
    return <p className="model-error">{settingsError}</p>
  }
  if (settingsData === null || piAi === undefined) {
    return <p className="placeholder">当前 dsh profile 没有模型设置分组（llm-pi-ai）。</p>
  }

  return (
    <div className="models-settings" data-testid="models-settings">
      {catalogState === 'loading' ? <p className="placeholder">正在读取模型目录…</p> : null}
      {catalogError !== null ? <p className="model-error">{catalogError}</p> : null}
      {conflict !== null ? <p className="placeholder">{conflict}</p> : null}
      {error !== null ? (
        <p className="model-error" role="alert" data-testid="models-settings-error">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="muted" data-testid="models-settings-notice">
          {notice}
        </p>
      ) : null}

      <section className="settings-section">
        <h3 className="settings-section-title">全局默认模型</h3>
        <p className="muted">
          新建会话、以及未指定模型的会话恢复时使用它；会话内仍可在聊天栏临时切换。
        </p>
        <select
          className="model-select"
          value={
            currentDefault === null ? '' : `${currentDefault.provider}/${currentDefault.model}`
          }
          disabled={busy || defaultNs === undefined}
          onChange={(event) => {
            void selectDefault(event.currentTarget.value)
          }}
          data-testid="default-model-selector"
        >
          <option value="">（未设置）</option>
          {defaultOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">提供商</h3>
        <p className="muted">
          填入各提供商的 API 密钥即可使用其模型；自定义 API 可连接中转站或自部署服务。
        </p>
        <ul className="provider-list">
          {cards.map((card) => (
            <li
              className="provider-card"
              key={card.provider}
              data-testid={`provider-${card.provider}`}
            >
              <div className="provider-card-main">
                <span className="provider-card-name">{card.displayName}</span>
                <span className="provider-card-meta mono">{card.provider}</span>
                <span className="provider-card-tags">
                  <span className={`provider-tag${card.live ? ' provider-tag-live' : ''}`}>
                    {card.live ? '已生效' : '未生效'}
                  </span>
                  {card.declared ? <span className="provider-tag">自定义</span> : null}
                  {card.credentialConfigured === true ? (
                    <span className="provider-tag provider-tag-ok">密钥已配置</span>
                  ) : card.credentialConfigured === false ? (
                    <span className="provider-tag provider-tag-warn">密钥缺失</span>
                  ) : null}
                  {card.error !== undefined ? (
                    <span className="provider-tag provider-tag-warn">{card.error}</span>
                  ) : null}
                </span>
              </div>
              <div className="provider-card-actions">
                {card.declared ? (
                  <button
                    type="button"
                    className="graph-chip"
                    disabled={busy}
                    onClick={() => openEditor(card)}
                    data-testid={`provider-edit-${card.provider}`}
                  >
                    编辑
                  </button>
                ) : null}
                {modelsNamespaceOf(card) !== undefined ? (
                  <button
                    type="button"
                    className="graph-chip"
                    disabled={busy}
                    onClick={() => openCatalogEditor(card)}
                    data-testid={`provider-models-${card.provider}`}
                  >
                    编辑模型目录
                  </button>
                ) : null}
                {card.credentialConfigured !== undefined ? (
                  <button
                    type="button"
                    className="graph-chip"
                    disabled={busy}
                    onClick={() => {
                      setKeyEditor((current) =>
                        current?.provider === card.provider
                          ? null
                          : { provider: card.provider, value: '' },
                      )
                    }}
                    data-testid={`provider-key-${card.provider}`}
                  >
                    {card.credentialConfigured ? '更换密钥' : '填写密钥'}
                  </button>
                ) : null}
                {card.credentialConfigured === true ? (
                  <button
                    type="button"
                    className="graph-chip"
                    disabled={busy}
                    onClick={() => void clearCredential(card.provider)}
                  >
                    清除密钥
                  </button>
                ) : null}
                {card.removable ? (
                  <button
                    type="button"
                    className="graph-chip graph-chip-danger"
                    disabled={busy}
                    onClick={() => void removeProvider(card)}
                    data-testid={`provider-remove-${card.provider}`}
                  >
                    删除
                  </button>
                ) : null}
              </div>
              {keyEditor !== null && keyEditor.provider === card.provider ? (
                <div className="provider-key-editor">
                  <input
                    className="model-input"
                    type="password"
                    value={keyEditor.value}
                    placeholder="输入 API 密钥（不会回显）"
                    onChange={(event) =>
                      setKeyEditor({ provider: card.provider, value: event.currentTarget.value })
                    }
                    data-testid={`provider-key-input-${card.provider}`}
                  />
                  <button
                    type="button"
                    className="graph-chip graph-chip-active"
                    disabled={busy || keyEditor.value.trim() === ''}
                    onClick={() => {
                      const value = keyEditor.value
                      void saveCredential(card.provider, value).then((ok) => {
                        if (ok) setKeyEditor(null)
                      })
                    }}
                    data-testid={`provider-key-save-${card.provider}`}
                  >
                    保存
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="graph-chip graph-chip-active"
          disabled={busy}
          onClick={() => {
            setAddOpen((open) => !open)
            setError(null)
            setNotice(null)
          }}
          data-testid="provider-add"
        >
          添加模型提供商
        </button>

        {addOpen ? (
          <div className="provider-add" data-testid="provider-add-form">
            <div className="provider-add-modes">
              <button
                type="button"
                className={`graph-chip${addMode === 'catalog' ? ' graph-chip-active' : ''}`}
                onClick={() => setAddMode('catalog')}
              >
                第三方模型提供商
              </button>
              <button
                type="button"
                className={`graph-chip${addMode === 'custom' ? ' graph-chip-active' : ''}`}
                onClick={() => setAddMode('custom')}
              >
                自定义模型 API
              </button>
            </div>
            {addMode === 'catalog' ? (
              <>
                <label className="model-field">
                  <span className="muted">提供商（内置目录）</span>
                  <select
                    className="model-select"
                    value={catalogPick}
                    onChange={(event) => setCatalogPick(event.currentTarget.value)}
                  >
                    <option value="">选择提供商…</option>
                    {catalogCandidates.map((card) => (
                      <option key={card.provider} value={card.provider}>
                        {card.displayName}（{card.provider}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="model-field">
                  <span className="muted">API 密钥</span>
                  <input
                    className="model-input"
                    type="password"
                    value={catalogKey}
                    placeholder="输入 API 密钥（可留空稍后填写）"
                    onChange={(event) => setCatalogKey(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  className="graph-chip graph-chip-active"
                  disabled={busy || catalogPick === ''}
                  onClick={() => {
                    void run('添加提供商', addCatalogProvider).then((ok) => {
                      if (ok) {
                        setAddOpen(false)
                        setCatalogKey('')
                        setNotice('提供商已添加')
                      }
                    })
                  }}
                  data-testid="provider-add-catalog-submit"
                >
                  添加
                </button>
              </>
            ) : (
              <>
                <label className="model-field">
                  <span className="muted">Provider ID（小写字母开头）</span>
                  <input
                    className="model-input"
                    value={customRoute}
                    onChange={(event) => setCustomRoute(event.currentTarget.value)}
                  />
                </label>
                <label className="model-field">
                  <span className="muted">显示名称</span>
                  <input
                    className="model-input"
                    value={customName}
                    onChange={(event) => setCustomName(event.currentTarget.value)}
                  />
                </label>
                <label className="model-field">
                  <span className="muted">API 协议</span>
                  <select
                    className="model-select"
                    value={customApi}
                    onChange={(event) =>
                      setCustomApi(event.currentTarget.value as (typeof API_PROTOCOLS)[number])
                    }
                  >
                    {API_PROTOCOLS.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {protocol}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="model-field">
                  <span className="muted">API 地址（Base URL）</span>
                  <input
                    className="model-input"
                    value={customBaseUrl}
                    placeholder="https://gateway.example/v1"
                    onChange={(event) => setCustomBaseUrl(event.currentTarget.value)}
                  />
                </label>
                <label className="model-field">
                  <span className="muted">模型（每行一个，可写 id|显示名）</span>
                  <textarea
                    className="model-input provider-models-input"
                    value={customModels}
                    rows={4}
                    onChange={(event) => setCustomModels(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  className="graph-chip"
                  disabled={busy || customBaseUrl.trim() === ''}
                  onClick={() => {
                    void fetchModels({
                      namespace: 'llm-pi-ai',
                      baseURL: customBaseUrl,
                      api: customApi,
                      ...(customKey.trim() === '' ? {} : { apiKey: customKey }),
                      apply: setCustomModels,
                    })
                  }}
                  data-testid="provider-fetch-models"
                >
                  获取可用模型
                </button>
                <label className="model-field">
                  <span className="muted">API 密钥（可选）</span>
                  <input
                    className="model-input"
                    type="password"
                    value={customKey}
                    onChange={(event) => setCustomKey(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  className="graph-chip graph-chip-active"
                  disabled={busy || customRoute === ''}
                  onClick={() => {
                    void run('添加自定义提供商', addCustomProvider).then((ok) => {
                      if (ok) {
                        setAddOpen(false)
                        setCustomKey('')
                        setNotice('自定义提供商已添加')
                      }
                    })
                  }}
                  data-testid="provider-add-custom-submit"
                >
                  创建提供商
                </button>
              </>
            )}
          </div>
        ) : null}
      </section>

      {editing !== null ? (
        <div className="rename-backdrop">
          <button
            type="button"
            className="settings-backdrop-hit"
            aria-label="关闭"
            onClick={() => setEditing(null)}
          />
          <section className="rename-modal" role="dialog" aria-modal="true" aria-label="编辑提供商">
            <header className="rename-head">
              <span className="rename-title">编辑 {editing.displayName}</span>
            </header>
            <label className="model-field">
              <span className="muted">显示名称</span>
              <input
                className="model-input"
                value={editName}
                onChange={(event) => setEditName(event.currentTarget.value)}
              />
            </label>
            <label className="model-field">
              <span className="muted">API 协议</span>
              <select
                className="model-select"
                value={editApi}
                onChange={(event) =>
                  setEditApi(event.currentTarget.value as (typeof API_PROTOCOLS)[number])
                }
              >
                {API_PROTOCOLS.map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {protocol}
                  </option>
                ))}
              </select>
            </label>
            <label className="model-field">
              <span className="muted">API 地址（Base URL）</span>
              <input
                className="model-input"
                value={editBaseUrl}
                onChange={(event) => setEditBaseUrl(event.currentTarget.value)}
              />
            </label>
            <label className="model-field">
              <span className="muted">模型（每行一个，可写 id|显示名）</span>
              <textarea
                className="model-input provider-models-input"
                value={editModels}
                rows={5}
                onChange={(event) => setEditModels(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="graph-chip"
              disabled={busy || editBaseUrl.trim() === ''}
              onClick={() => {
                void fetchModels({
                  namespace: 'llm-pi-ai',
                  baseURL: editBaseUrl,
                  api: editApi,
                  apply: setEditModels,
                })
              }}
            >
              获取可用模型
            </button>
            <label className="model-field">
              <span className="muted">更换 API 密钥（留空保持不变）</span>
              <input
                className="model-input"
                type="password"
                value={editKey}
                onChange={(event) => setEditKey(event.currentTarget.value)}
              />
            </label>
            <div className="rename-actions">
              <button type="button" className="graph-chip" onClick={() => setEditing(null)}>
                取消
              </button>
              <button
                type="button"
                className="graph-chip graph-chip-active"
                disabled={busy}
                onClick={() => {
                  void run('保存提供商', saveEditing).then((ok) => {
                    if (ok) {
                      setEditing(null)
                      setNotice('提供商配置已保存')
                    }
                  })
                }}
                data-testid="provider-edit-save"
              >
                保存
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {editingCatalog !== null ? (
        <div className="rename-backdrop">
          <button
            type="button"
            className="settings-backdrop-hit"
            aria-label="关闭"
            onClick={() => setEditingCatalog(null)}
          />
          <section
            className="rename-modal"
            role="dialog"
            aria-modal="true"
            aria-label="编辑模型目录"
          >
            <header className="rename-head">
              <span className="rename-title">模型目录 · {editingCatalog.card.displayName}</span>
            </header>
            <p className="muted">
              每行一个模型，可写 <code>id|显示名</code>；已有条目按 id 保留其全部参数 （上下文窗口 /
              输入类型 / 推理档位等）。
            </p>
            <label className="model-field">
              <span className="muted">模型（{editingCatalog.namespace.ns}）</span>
              <textarea
                className="model-input provider-models-input"
                value={catalogLines}
                rows={6}
                onChange={(event) => setCatalogLines(event.currentTarget.value)}
                data-testid="provider-models-input"
              />
            </label>
            {/* 无「获取可用模型」：整段式 provider（llm-deepseek 等）没有注册 discovery，
                官方同样只能手工维护模型表。 */}
            <div className="rename-actions">
              <button
                type="button"
                className="graph-chip graph-chip-danger"
                disabled={busy}
                onClick={() => {
                  void run('恢复默认模型', resetCatalogModels).then((ok) => {
                    if (ok) setNotice('已恢复默认模型目录')
                  })
                }}
                data-testid="provider-models-reset"
              >
                恢复默认
              </button>
              <button type="button" className="graph-chip" onClick={() => setEditingCatalog(null)}>
                取消
              </button>
              <button
                type="button"
                className="graph-chip graph-chip-active"
                disabled={busy}
                onClick={() => {
                  void run('保存模型目录', saveCatalogModels).then((ok) => {
                    if (ok) {
                      setEditingCatalog(null)
                      setNotice('模型目录已保存')
                    }
                  })
                }}
                data-testid="provider-models-save"
              >
                保存
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {saving ? <p className="muted">保存中…</p> : null}
    </div>
  )
}

function recordJson(value: UnknownRecord | undefined): { [key: string]: JsonValue } | undefined {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as { [key: string]: JsonValue }
}

/** 控制面统一应答解包（`{ok:true,result}` / `{ok:false,error}`）。 */
function unwrapControl(raw: unknown): unknown {
  const value = raw as { ok?: unknown; result?: unknown; error?: { message?: unknown } }
  if (value.ok !== true) {
    throw new Error(
      value.error !== undefined && typeof value.error.message === 'string'
        ? value.error.message
        : '控制请求失败',
    )
  }
  return value.result
}
