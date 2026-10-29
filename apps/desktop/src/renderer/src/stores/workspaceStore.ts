import { create } from 'zustand'
import {
  emptyWorkspaceIndex,
  linkSessionToWorkspace,
  parseActiveWorkspaceId,
  parseWorkspaceIndex,
  registerWorkspace,
  serializeActiveWorkspaceId,
  type WorkspaceIndex,
  type WorkspaceRecord,
} from '../core/workspaces'

const STORAGE_KEY = 'dex.workspaces.v1'
const ACTIVE_STORAGE_KEY = 'dex.workspace.active.v1'

function read(): WorkspaceIndex {
  if (typeof localStorage === 'undefined') return emptyWorkspaceIndex
  return parseWorkspaceIndex(localStorage.getItem(STORAGE_KEY))
}

function write(index: WorkspaceIndex): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(index))
}

function readActiveId(index: WorkspaceIndex): string | null {
  if (typeof localStorage === 'undefined') return null
  return parseActiveWorkspaceId(localStorage.getItem(ACTIVE_STORAGE_KEY), index.workspaces)
}

function writeActiveId(id: string | null): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ACTIVE_STORAGE_KEY, serializeActiveWorkspaceId(id))
}

export interface WorkspaceStore extends WorkspaceIndex {
  activeWorkspaceId: string | null
  register: (path: string) => WorkspaceRecord
  linkSession: (sessionId: string, workspace: WorkspaceRecord) => void
  unlinkSession: (sessionId: string) => void
  activate: (workspaceId: string | null) => void
  forget: (workspaceId: string) => void
}

const bootIndex = read()

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  ...bootIndex,
  activeWorkspaceId: readActiveId(bootIndex),
  register: (path) => {
    const result = registerWorkspace(get(), path)
    write(result.index)
    writeActiveId(result.workspace.id)
    set({ ...result.index, activeWorkspaceId: result.workspace.id })
    return result.workspace
  },
  linkSession: (sessionId, workspace) => {
    const index = linkSessionToWorkspace(get(), sessionId, workspace)
    write(index)
    set(index)
  },
  unlinkSession: (sessionId) => {
    const state = get()
    if (state.sessionWorkspace[sessionId] === undefined) return
    const sessionWorkspace = { ...state.sessionWorkspace }
    delete sessionWorkspace[sessionId]
    write({ workspaces: state.workspaces, sessionWorkspace })
    set({ sessionWorkspace })
  },
  activate: (workspaceId) => {
    writeActiveId(workspaceId)
    set({ activeWorkspaceId: workspaceId })
  },
  forget: (workspaceId) => {
    const state = get()
    const index: WorkspaceIndex = {
      workspaces: state.workspaces.filter((item) => item.id !== workspaceId),
      sessionWorkspace: Object.fromEntries(
        Object.entries(state.sessionWorkspace).filter(([, id]) => id !== workspaceId),
      ),
    }
    const activeWorkspaceId =
      state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId
    write(index)
    writeActiveId(activeWorkspaceId)
    set({ ...index, activeWorkspaceId })
  },
}))
