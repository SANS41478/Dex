import { create } from 'zustand'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export interface ConnectionStore {
  status: ConnectionStatus
  receivedCount: number
  setStatus: (status: ConnectionStatus) => void
  markReceived: () => void
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'connecting',
  receivedCount: 0,
  setStatus: (status) => {
    set({ status })
  },
  markReceived: () => {
    set((state) => ({ receivedCount: state.receivedCount + 1 }))
  },
}))
