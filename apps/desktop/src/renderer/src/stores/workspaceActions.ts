import { sessionDeleteResultSchema, workspacePickResultSchema } from '@dexagent/shared'
import { rememberActiveSession } from '../core/session-restore'
import { normalizeWorkspacePath, type WorkspaceRecord } from '../core/workspaces'
import { useChatStore } from './chatStore'
import { useHostWorkspaceStore } from './hostWorkspaceStore'
import { useNavigationStore } from './navigationStore'
import { useSessionStore } from './sessionStore'
import { useSessionUnreadStore } from './sessionUnreadStore'
import { useTraceStore } from './traceStore'
import { useWorkspaceStore } from './workspaceStore'

interface ControlEnvelope<T> {
  readonly ok: boolean
  readonly result?: T
  readonly error?: { readonly message?: string }
}

async function unwrap<T>(call: Promise<unknown>): Promise<T> {
  const raw = (await call) as ControlEnvelope<T>
  if (raw.ok !== true || raw.result === undefined) {
    throw new Error(raw.error?.message ?? '操作失败')
  }
  return raw.result
}

export function sessionIdsOfWorkspace(input: {
  readonly workspace: Pick<WorkspaceRecord, 'id' | 'path'>
  readonly sessions: readonly {
    readonly sessionId: string
    readonly cwd?: string | undefined
  }[]
  readonly sessionWorkspace: Readonly<Record<string, string>>
  readonly hostSessionIds?: readonly string[]
  readonly activeSessionId?: string | null
  readonly activeWorkspacePath?: string | null
  readonly localBlankWorkspacePaths?: readonly string[]
}): readonly string[] {
  const path = normalizeWorkspacePath(input.workspace.path)
  const ids = new Set<string>(input.hostSessionIds ?? [])
  for (const session of input.sessions) {
    const byCwd = session.cwd !== undefined && normalizeWorkspacePath(session.cwd) === path
    const byAlias = input.sessionWorkspace[session.sessionId] === input.workspace.id
    if (byCwd || byAlias) ids.add(session.sessionId)
  }
  for (const blankPath of input.localBlankWorkspacePaths ?? []) {
    if (normalizeWorkspacePath(blankPath) === path && input.activeSessionId !== null) {
      ids.add(input.activeSessionId as string)
    }
  }
  if (
    input.activeSessionId !== null &&
    input.activeSessionId !== undefined &&
    input.activeWorkspacePath !== null &&
    input.activeWorkspacePath !== undefined &&
    normalizeWorkspacePath(input.activeWorkspacePath) === path
  ) {
    ids.add(input.activeSessionId)
  }
  return [...ids]
}

function forgetSessionUiState(sessionId: string): void {
  const chat = useChatStore.getState()
  const wasActive = chat.activeSessionId === sessionId
  if (wasActive) chat.clear({ forgetBlank: true })
  if (useTraceStore.getState().replaySessionId === sessionId) useTraceStore.getState().clear()
  if (useSessionStore.getState().selectedId === sessionId) {
    useSessionStore.setState({ selectedId: null })
  }
  useNavigationStore.getState().remove(sessionId)
  useSessionUnreadStore.getState().markRead(sessionId)
  useWorkspaceStore.getState().unlinkSession(sessionId)
  useChatStore.setState((state) => ({
    blankSessions: state.blankSessions.filter((item) => item.sessionId !== sessionId),
  }))
  useSessionStore.setState((state) => ({
    index: {
      ...state.index,
      pinned: state.index.pinned.filter((id) => id !== sessionId),
      hidden: state.index.hidden.filter((id) => id !== sessionId),
    },
  }))
  if (wasActive) rememberActiveSession(null)
}

export async function addWorkspaceAndCreateSession(): Promise<WorkspaceRecord | null> {
  if (window.dex === undefined) throw new Error('添加工作区仅在 Electron 宿主中可用')
  const picked = workspacePickResultSchema.parse(await window.dex.workspace.pick())
  if (picked.canceled) return null
  const workspace = useWorkspaceStore.getState().register(picked.path)
  await useChatStore.getState().newSession(workspace)
  return workspace
}

export async function archiveSession(sessionId: string, stopActivity = false): Promise<void> {
  try {
    await useHostWorkspaceStore.getState().archive(sessionId, stopActivity ? true : undefined)
  } catch (error) {
    if ((error as { code?: string }).code !== 'SESSION_NOT_FOUND') throw error
  }
  forgetSessionUiState(sessionId)
  await useSessionStore.getState().load()
}

export async function deleteWorkspaceCascade(workspace: WorkspaceRecord): Promise<number> {
  const host = useHostWorkspaceStore.getState()
  const sessionState = useSessionStore.getState()
  const workspaceState = useWorkspaceStore.getState()
  const chat = useChatStore.getState()
  const normalizedPath = normalizeWorkspacePath(workspace.path)
  const hostWorkspace = host.workspaces.find(
    (item) => normalizeWorkspacePath(item.path) === normalizedPath,
  )
  const ids = sessionIdsOfWorkspace({
    workspace,
    sessions: sessionState.sessions,
    sessionWorkspace: workspaceState.sessionWorkspace,
    ...(hostWorkspace === undefined ? {} : { hostSessionIds: hostWorkspace.sessionIds }),
    activeSessionId: chat.activeSessionId,
    activeWorkspacePath: chat.workspacePath,
    localBlankWorkspacePaths: chat.blankSessions.map((item) => item.workspacePath),
  })
  const archived = new Set(host.archived)
  for (const sessionId of ids) {
    if (!archived.has(sessionId)) {
      try {
        await host.archive(sessionId, true)
      } catch (error) {
        if ((error as { code?: string }).code !== 'SESSION_NOT_FOUND') throw error
      }
    }
    forgetSessionUiState(sessionId)
  }
  await host.deleteByPath(workspace.path)
  useWorkspaceStore.getState().forget(workspace.id)
  await useSessionStore.getState().load()
  return ids.length
}

export async function deleteOrphanSession(sessionId: string): Promise<void> {
  if (window.dex?.sessions === undefined) {
    throw new Error('删除会话仅在 Electron 宿主中可用')
  }
  const host = useHostWorkspaceStore.getState()
  if (host.pinned.includes(sessionId)) await host.unpin(sessionId)
  if (host.archived.includes(sessionId)) await host.unarchive(sessionId)
  sessionDeleteResultSchema.parse(await unwrap(window.dex.sessions.delete(sessionId)))
  forgetSessionUiState(sessionId)
  await useSessionStore.getState().load()
}
