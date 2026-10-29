import { create } from 'zustand'
import { nextSelection } from '../core/timeline'

/** 执行流选中态（DAG 与时间线共用；值为节点 id：turn/step/tool 均可）。 */
export interface TraceSelectionStore {
  selectedId: string | null
  select: (id: string | null) => void
  toggle: (id: string) => void
}

export const useTraceSelectionStore = create<TraceSelectionStore>((set, get) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  toggle: (id) => set({ selectedId: nextSelection(get().selectedId, id) }),
}))
