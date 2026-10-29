import { create } from 'zustand'

export interface GraphFocusRequest {
  readonly nodeId: string
  readonly nonce: number
}

/** 图谱↔执行流的联动状态（M2-05）。 */
export interface LinkageStoreState {
  /** 执行流过滤：只看调用该插件节点的 Step（null = 不过滤）。 */
  pluginFilterId: string | null
  /** 一次性聚焦请求：详情卡里点插件 → 图谱正式选中并聚焦。 */
  focusRequest: GraphFocusRequest | null
  setPluginFilter: (id: string | null) => void
  requestGraphFocus: (nodeId: string) => void
  clearFocusRequest: () => void
}

export const useLinkageStore = create<LinkageStoreState>((set) => ({
  pluginFilterId: null,
  focusRequest: null,
  setPluginFilter: (pluginFilterId) => set({ pluginFilterId }),
  requestGraphFocus: (nodeId) => set({ focusRequest: { nodeId, nonce: Date.now() } }),
  clearFocusRequest: () => set({ focusRequest: null }),
}))
