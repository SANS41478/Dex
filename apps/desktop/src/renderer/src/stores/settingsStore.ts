import {
  type SettingsDescribe,
  type SettingsMutateRequest,
  settingsDescribeSchema,
  settingsMutateRequestSchema,
  settingsMutationResponseSchema,
} from '@dexagent/shared'
import { create } from 'zustand'

export type SettingsLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface SettingsStore {
  data: SettingsDescribe | null
  loadState: SettingsLoadState
  saving: boolean
  error: string | null
  conflict: string | null
  load: () => Promise<void>
  mutate: (input: SettingsMutateRequest) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  data: null,
  loadState: 'idle',
  saving: false,
  error: null,
  conflict: null,
  load: async () => {
    set({ loadState: 'loading', error: null })
    try {
      const value = settingsDescribeSchema.parse(await window.dex.settings.describe())
      set({ data: value, loadState: 'ready', error: null })
    } catch (error) {
      set({
        loadState: 'error',
        error: error instanceof Error ? error.message : '全局设置读取失败',
      })
    }
  },
  mutate: async (input) => {
    const request = settingsMutateRequestSchema.parse(input)
    set({ error: null, conflict: null, saving: true })
    try {
      const response = settingsMutationResponseSchema.parse(
        await window.dex.settings.mutate(request),
      )
      if (!response.ok) {
        if (response.error.code === 'SETTINGS_CONFLICT') {
          await get().load()
          set({ conflict: '设置已被其他操作更新，已载入最新值；请确认后重新修改。' })
          return
        }
        set({ error: response.error.message })
        return
      }
      const current = get().data
      if (current !== null) {
        set({
          data: {
            ...current,
            namespaces: current.namespaces.map((namespace) =>
              namespace.ns === response.result.ns ? response.result : namespace,
            ),
          },
          error: null,
          conflict: null,
        })
      } else {
        await get().load()
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '全局设置写入失败' })
    } finally {
      set({ saving: false })
    }
  },
}))
