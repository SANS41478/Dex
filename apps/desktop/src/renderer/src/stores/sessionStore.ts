import {
  type SessionSummary,
  sessionListSchema,
  sessionReplaySchema,
  sortSessionSummaries,
} from '@dexagent/shared'
import { create } from 'zustand'
import { useTraceStore } from './traceStore'

export interface SessionUiIndex {
  pinned: string[]
  hidden: string[]
  lastSelected?: string
}

export interface SessionStore {
  sessions: readonly SessionSummary[]
  index: SessionUiIndex
  selectedId: string | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
  replay: (sessionId: string, live?: boolean) => Promise<void>
  togglePinned: (sessionId: string) => void
  /** 置顶迁到宿主权威集合后，清空本地遗留的 pinned（一次性迁移用）。 */
  clearPinned: () => void
  markNonBlank: (sessionId: string) => void
}

const STORAGE_KEY = 'dex.session-index.v1'
const emptyIndex: SessionUiIndex = { pinned: [], hidden: [] }

function readIndex(): SessionUiIndex {
  if (typeof localStorage === 'undefined') return emptyIndex
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    if (parsed === null || typeof parsed !== 'object') return emptyIndex
    const value = parsed as Partial<SessionUiIndex>
    return {
      pinned: Array.isArray(value.pinned)
        ? value.pinned.filter((id): id is string => typeof id === 'string')
        : [],
      hidden: Array.isArray(value.hidden)
        ? value.hidden.filter((id): id is string => typeof id === 'string')
        : [],
      ...(typeof value.lastSelected === 'string' ? { lastSelected: value.lastSelected } : {}),
    }
  } catch {
    return emptyIndex
  }
}

function writeIndex(index: SessionUiIndex): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(index))
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  index: readIndex(),
  selectedId: null,
  loading: false,
  error: null,
  load: async () => {
    if (window.dex?.sessions === undefined) {
      set({ sessions: [], loading: false })
      return
    }
    set({ loading: true, error: null })
    try {
      const all: SessionSummary[] = []
      let cursor: string | undefined
      do {
        const page = sessionListSchema.parse(await window.dex.sessions.list(cursor))
        all.push(...page.sessions)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      set({ sessions: sortSessionSummaries(all), loading: false })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '会话历史加载失败',
      })
    }
  },
  replay: async (sessionId, live = false) => {
    if (window.dex?.sessions === undefined) throw new Error('会话回放仅在 Electron 宿主中可用')
    set({ loading: true, error: null })
    try {
      const replay = sessionReplaySchema.parse(await window.dex.sessions.replay(sessionId))
      if (live) useTraceStore.getState().restoreLive(replay.traceState, sessionId)
      else useTraceStore.getState().replace(replay.traceState, sessionId)
      const nextIndex = { ...get().index, lastSelected: sessionId }
      writeIndex(nextIndex)
      set({ selectedId: sessionId, index: nextIndex, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '会话回放失败',
      })
    }
  },
  togglePinned: (sessionId) => {
    const index = get().index
    const pinned = index.pinned.includes(sessionId)
      ? index.pinned.filter((id) => id !== sessionId)
      : [...index.pinned, sessionId]
    const next = { ...index, pinned }
    writeIndex(next)
    set({ index: next })
  },
  clearPinned: () => {
    const next = { ...get().index, pinned: [] }
    writeIndex(next)
    set({ index: next })
  },
  markNonBlank: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, blank: false } : session,
      ),
    })),
}))
