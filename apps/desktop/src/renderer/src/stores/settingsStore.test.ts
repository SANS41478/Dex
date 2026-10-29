import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

const namespace = {
  autoGenerate: true,
  ns: 'general',
  schema: { uid: 'root', refs: { root: { type: 'object' } } },
  value: { enabled: false },
  applies: 'live' as const,
  secrets: [{ path: ['token'], set: true }],
  revision: 4,
}

function installSettingsApi(api: {
  describe: () => Promise<unknown>
  mutate: () => Promise<unknown>
}): void {
  ;(globalThis as unknown as { window: unknown }).window = { dex: { settings: api } }
}

beforeEach(() => {
  useSettingsStore.setState({
    data: null,
    loadState: 'idle',
    saving: false,
    error: null,
    conflict: null,
  })
})

describe('settingsStore', () => {
  it('loads a redacted global settings descriptor into ready state', async () => {
    const describe = vi.fn(async () => ({
      writable: true,
      hasDocument: true,
      namespaces: [namespace],
    }))
    installSettingsApi({ describe, mutate: vi.fn(async () => ({})) })

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().loadState).toBe('ready')
    expect(useSettingsStore.getState().data?.namespaces[0]?.revision).toBe(4)
  })

  it('on a revision conflict reloads the authoritative value without optimistic write', async () => {
    const latest = { ...namespace, value: { enabled: true }, revision: 5 }
    const describe = vi.fn(async () => ({
      writable: true,
      hasDocument: true,
      namespaces: [latest],
    }))
    const mutate = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'SETTINGS_CONFLICT',
        message: 'settings changed since revision 4',
        retryable: false,
      },
    }))
    installSettingsApi({ describe, mutate })
    useSettingsStore.setState({
      data: { writable: true, hasDocument: true, namespaces: [namespace] },
      loadState: 'ready',
    })

    await useSettingsStore.getState().mutate({
      namespace: 'general',
      operations: [{ op: 'set', path: ['enabled'], value: true }],
      expectedRevision: 4,
    })

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(describe).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().data?.namespaces[0]).toMatchObject({
      value: { enabled: true },
      revision: 5,
    })
    expect(useSettingsStore.getState().conflict).toContain('重新修改')
    expect(useSettingsStore.getState().saving).toBe(false)
  })
})
