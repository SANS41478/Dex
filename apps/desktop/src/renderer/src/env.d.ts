/// <reference types="vite/client" />

import type { TraceMessage } from '@dexagent/shared'
import type { TraceStore } from './stores/traceStore'

declare global {
  interface Window {
    /**
     * DEV 诊断钩子：直接驱动 renderer 的 trace store（诊断 / 手工复现用）。
     *
     * 为什么不从页面里 `import('/src/stores/traceStore.ts')`：那样会拿到**另一个**模块实例，
     * 注入的状态与界面订阅的 store 不是同一个（实测「注入成功但面板仍 0 轮」）。
     * 只读探针 + 注入口都在这里收口，生产构建不注入（与 `__dexGraphDebug` 同约定）。
     */
    __dexTraceDebug?: {
      dispatch: (message: TraceMessage) => void
      state: () => Pick<TraceStore, 'turns' | 'viewMode' | 'policyChanges' | 'approvals'>
      clear: () => void
    }
  }
}
