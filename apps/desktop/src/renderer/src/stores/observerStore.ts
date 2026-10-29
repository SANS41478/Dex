import { create } from 'zustand'

export type ObserverFlowView = 'dag' | 'timeline'

interface ObserverState {
  visible: boolean
  flowView: ObserverFlowView
  toggle: () => void
  setFlowView: (view: ObserverFlowView) => void
}

export const useObserverStore = create<ObserverState>((set) => ({
  visible: true,
  flowView: 'dag',
  toggle: () => set((state) => ({ visible: !state.visible })),
  setFlowView: (flowView) => set({ flowView }),
}))
