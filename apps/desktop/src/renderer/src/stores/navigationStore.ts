import { create } from 'zustand'

interface NavigationState {
  entries: readonly string[]
  index: number
  /** 设置抽屉开合（C-4）：AppSidebar 设置按钮的唯一消费者。 */
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  push: (entry: string) => void
  remove: (entry: string) => void
  back: () => string | null
  forward: () => string | null
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  entries: [],
  index: -1,
  settingsOpen: false,
  openSettings: () => {
    set({ settingsOpen: true })
  },
  closeSettings: () => {
    set({ settingsOpen: false })
  },
  push: (entry) => {
    const state = get()
    const current = state.entries[state.index]
    if (current === entry) return
    const entries = [...state.entries.slice(0, state.index + 1), entry].slice(-50)
    set({ entries, index: entries.length - 1 })
  },
  remove: (entry) => {
    const state = get()
    if (!state.entries.includes(entry)) return
    const removedBefore = state.entries
      .slice(0, state.index + 1)
      .filter((id) => id === entry).length
    const entries = state.entries.filter((id) => id !== entry)
    const index =
      entries.length === 0
        ? -1
        : Math.max(0, Math.min(entries.length - 1, state.index - removedBefore))
    set({ entries, index })
  },
  back: () => {
    const state = get()
    if (state.index <= 0) return null
    const index = state.index - 1
    set({ index })
    return state.entries[index] ?? null
  },
  forward: () => {
    const state = get()
    if (state.index >= state.entries.length - 1) return null
    const index = state.index + 1
    set({ index })
    return state.entries[index] ?? null
  },
}))
