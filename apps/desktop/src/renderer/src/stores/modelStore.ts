import {
  type ModelCatalog,
  type ModelSelection,
  modelCatalogSchema,
  modelSelectionSchema,
} from '@dexagent/shared'
import { create } from 'zustand'

export type ModelLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface ModelStore {
  catalog: ModelCatalog
  loadState: ModelLoadState
  error: string | null
  load: (sessionId?: string) => Promise<void>
  select: (sessionId: string, selection: ModelSelection) => Promise<void>
  setCredential: (provider: string, apiKey: string) => Promise<void>
  unsetCredential: (provider: string) => Promise<void>
}

const emptyCatalog: ModelCatalog = {
  providers: [],
  configurable: [],
  selection: null,
  defaultSelection: null,
}

export const useModelStore = create<ModelStore>((set) => ({
  catalog: emptyCatalog,
  loadState: 'idle',
  error: null,
  load: async (sessionId) => {
    set({ loadState: 'loading', error: null })
    try {
      if (window.dex?.models === undefined) {
        set({ catalog: emptyCatalog, loadState: 'ready' })
        return
      }
      const value = modelCatalogSchema.parse(await window.dex.models.list(sessionId))
      set({ catalog: value, loadState: 'ready' })
    } catch (error) {
      set({
        loadState: 'error',
        error: error instanceof Error ? error.message : '模型目录加载失败',
      })
    }
  },
  select: async (sessionId, selection) => {
    if (window.dex?.models === undefined) throw new Error('模型控制仅在 Electron 宿主中可用')
    const value = modelSelectionSchema.parse(await window.dex.models.select(sessionId, selection))
    set((state) => ({ catalog: { ...state.catalog, selection: value }, error: null }))
  },
  setCredential: async (provider, apiKey) => {
    if (window.dex?.models === undefined) throw new Error('模型控制仅在 Electron 宿主中可用')
    await window.dex.models.setCredential(provider, apiKey)
    set((state) => ({
      catalog: {
        ...state.catalog,
        providers: state.catalog.providers.map((item) =>
          item.id === provider
            ? { ...item, credential: { ...item.credential, configured: true } }
            : item,
        ),
      },
      error: null,
    }))
  },
  unsetCredential: async (provider) => {
    if (window.dex?.models === undefined) throw new Error('模型控制仅在 Electron 宿主中可用')
    await window.dex.models.unsetCredential(provider)
    set((state) => ({
      catalog: {
        ...state.catalog,
        providers: state.catalog.providers.map((item) =>
          item.id === provider
            ? { ...item, credential: { ...item.credential, configured: false } }
            : item,
        ),
      },
      error: null,
    }))
  },
}))
