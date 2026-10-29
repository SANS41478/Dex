import { create } from 'zustand'

export type HostPhase = 'starting' | 'ready' | 'stopped' | 'error' | 'missing'

export interface HostStatusPayload {
  phase: HostPhase
  detail?: string | undefined
}

export interface HostStore {
  phase: HostPhase | 'unknown'
  detail: string | null
  updatedAt: number
  setStatus: (status: HostStatusPayload) => void
}

export const useHostStore = create<HostStore>((set) => ({
  phase: 'unknown',
  detail: null,
  updatedAt: 0,
  setStatus: (status) => {
    set({
      phase: status.phase,
      detail: status.detail ?? null,
      updatedAt: Date.now(),
    })
  },
}))
