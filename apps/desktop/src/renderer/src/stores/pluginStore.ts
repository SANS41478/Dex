import { type PluginsList, pluginsListSchema } from '@dexagent/shared'
import { create } from 'zustand'

export type PluginLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface PluginActionError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/** 启停结果横幅（overridden / restart-required 等人话提示）。 */
export interface PluginActionResult {
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly entryId: string
  readonly enabled?: boolean
}

export interface PluginStore {
  data: PluginsList | null
  loadState: PluginLoadState
  error: string | null
  /** 正在执行启停的条目（行级忙碌态）。 */
  actionEntryId: string | null
  actionResult: PluginActionResult | null
  actionError: PluginActionError | null
  load: () => Promise<void>
  setEnabled: (input: { readonly entryId: string; readonly enabled: boolean }) => Promise<void>
  clearAction: () => void
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  data: null,
  loadState: 'idle',
  error: null,
  actionEntryId: null,
  actionResult: null,
  actionError: null,
  load: async () => {
    set({ loadState: 'loading', error: null })
    try {
      const value = pluginsListSchema.parse(await window.dex.plugins.list())
      set({ data: value, loadState: 'ready', error: null })
    } catch (error) {
      set({
        loadState: 'error',
        error: error instanceof Error ? error.message : '插件列表读取失败',
      })
    }
  },
  setEnabled: async (input) => {
    set({ actionEntryId: input.entryId, actionResult: null, actionError: null })
    try {
      const raw: unknown = await window.dex.plugins.setEnabled(input)
      const envelope = raw as {
        ok?: unknown
        result?: unknown
        error?: { code?: unknown; message?: unknown; retryable?: unknown }
      }
      if (envelope.ok !== true) {
        // 启停失败：结构化错误（硬规则 8），由界面按 code 给人话。
        set({
          actionError: {
            code: typeof envelope.error?.code === 'string' ? envelope.error.code : 'PLUGIN_FAILED',
            message:
              typeof envelope.error?.message === 'string' ? envelope.error.message : '插件操作失败',
            retryable: envelope.error?.retryable === true,
          },
        })
        await get().load()
        return
      }
      const result = envelope.result as {
        application?: unknown
        enabled?: unknown
      }
      if (
        result?.application === 'applied' ||
        result?.application === 'restart-required' ||
        result?.application === 'overridden' ||
        result?.application === 'failed' ||
        result?.application === 'cancelled'
      ) {
        set({
          actionResult: {
            application: result.application,
            entryId: input.entryId,
            ...(typeof result.enabled === 'boolean' ? { enabled: result.enabled } : {}),
          },
        })
      }
      // 写入后刷新：`restart-required` 时盘上已变、运行态未变，界面展示以刷新结果为准。
      await get().load()
    } catch (error) {
      set({
        actionError: {
          code: 'PLUGIN_FAILED',
          message: error instanceof Error ? error.message : '插件操作失败',
          retryable: false,
        },
        actionEntryId: null,
      })
    } finally {
      set({ actionEntryId: null })
    }
  },
  clearAction: () => set({ actionResult: null, actionError: null }),
}))
