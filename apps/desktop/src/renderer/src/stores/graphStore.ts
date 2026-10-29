import type { GraphMessage } from '@dexagent/shared'
import { applyGraphMessage, type GraphState, initialGraphState } from '@dexagent/shared'
import { create } from 'zustand'

export interface GraphStore extends GraphState {
  dispatch: (message: GraphMessage) => void
}

export const useGraphStore = create<GraphStore>((set) => ({
  ...initialGraphState,
  dispatch: (message) => {
    set((state) => applyGraphMessage(state, message))
  },
}))
