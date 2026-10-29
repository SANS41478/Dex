import type { WorkspaceView } from '@dexagent/shared'
import { create } from 'zustand'
import { normalizeWorkspacePath, readIgnoredPaths, writeIgnoredPaths } from '../core/workspaces'

/**
 * 宿主工作区/会话控制面的 renderer 状态（UI-09）。
 *
 * 权威分工（照 dsh）：**归档集合与置顶集合在 host 的 workspace 门域**，
 * 工作区登记（id/path/title/顺序）也在 host；本地只保留两样东西：
 * - `ignoredPaths`：本地「已删除工作区」忽略表——dsh 的删除只是注销登记，
 *   而 Dex 侧栏按 cwd 推导分组，不忽略的话会话会把已删工作区重新推导出来；
 * - 展示偏好（归档过滤、手动顺序等）仍归各自 store。
 */

export interface ControlFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

type Envelope<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ControlFailure }

/** 解包主进程的统一控制应答；失败抛出带 `code` 的错误供 UI 分支。 */
async function unwrap<T>(call: Promise<unknown>): Promise<T> {
  const raw = (await call) as Envelope<T>
  if (raw.ok !== true) {
    const error = new Error(raw.error.message) as Error & { code?: string; retryable?: boolean }
    error.code = raw.error.code
    error.retryable = raw.error.retryable
    throw error
  }
  return raw.result
}

function unavailable(): Error {
  return new Error('工作区与会话管理仅在 Electron 宿主中可用')
}

export interface HostWorkspaceStore {
  readonly workspaces: readonly WorkspaceView[]
  /** 宿主登记顺序（`workspaces/list` 的 workspaceIds，uuid）。 */
  readonly workspaceIds: readonly string[]
  readonly pinned: readonly string[]
  readonly archived: readonly string[]
  readonly ignoredPaths: readonly string[]
  readonly loadState: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
  load: () => Promise<void>
  /** 登记目录为工作区（幂等）；成功后刷新登记表。 */
  create: (path: string) => Promise<void>
  /**
   * 按路径重命名工作区：宿主尚未登记该路径时先 create 再 rename
   * （cwd 推导出的工作区没有宿主记录，直接 rename 会 not-found）。
   */
  renameByPath: (path: string, title: string) => Promise<void>
  /** 删除工作区**登记**；会话归档由 `deleteWorkspaceCascade` 先行完成。 */
  deleteByPath: (path: string) => Promise<void>
  /**
   * 拖拽排序（UI-09 收口）：把 `path` 的工作区移到 `beforePath` 之前（缺省=末尾）。
   * 未登记的路径先静默登记——拖拽本身即「纳入登记顺序」的意图。
   */
  moveByPath: (path: string, beforePath?: string) => Promise<void>
  /** 撤销本地忽略（工作区重新按 cwd 推导出现）。 */
  restorePath: (path: string) => void
  pin: (sessionId: string) => Promise<void>
  unpin: (sessionId: string) => Promise<void>
  archive: (sessionId: string, stopActivity?: boolean) => Promise<void>
  unarchive: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 宿主登记的对应工作区（按规范化路径匹配；大小写不敏感）。 */
  workspaceForPath: (path: string) => WorkspaceView | undefined
}

export const useHostWorkspaceStore = create<HostWorkspaceStore>((set, get) => ({
  workspaces: [],
  workspaceIds: [],
  pinned: [],
  archived: [],
  ignoredPaths: readIgnoredPaths(),
  loadState: 'idle',
  error: null,
  load: async () => {
    if (window.dex?.workspaces === undefined) {
      set({ loadState: 'ready', error: null })
      return
    }
    set({ loadState: 'loading', error: null })
    try {
      const list = (await unwrap(window.dex.workspaces.list())) as {
        workspaces: readonly WorkspaceView[]
        workspaceIds: readonly string[]
        archivedSessionIds: readonly string[]
        pinnedSessionIds: readonly string[]
      }
      set({
        workspaces: list.workspaces,
        workspaceIds: list.workspaceIds,
        archived: list.archivedSessionIds,
        pinned: list.pinnedSessionIds,
        loadState: 'ready',
        error: null,
      })
    } catch (error) {
      set({
        loadState: 'error',
        error: error instanceof Error ? error.message : '工作区列表加载失败',
      })
    }
  },
  create: async (path) => {
    if (window.dex?.workspaces === undefined) throw unavailable()
    await unwrap(window.dex.workspaces.create(path))
    get().restorePath(path)
    await get().load()
  },
  renameByPath: async (path, title) => {
    if (window.dex?.workspaces === undefined) throw unavailable()
    const normalized = normalizeWorkspacePath(path)
    let workspace = get().workspaces.find(
      (item) => normalizeWorkspacePath(item.path) === normalized,
    )
    if (workspace === undefined) {
      const created = (await unwrap(window.dex.workspaces.create(path))) as {
        workspace: WorkspaceView
      }
      workspace = created.workspace
    }
    await unwrap(window.dex.workspaces.rename({ workspaceId: workspace.workspaceId, title }))
    await get().load()
  },
  deleteByPath: async (path) => {
    if (window.dex?.workspaces === undefined) throw unavailable()
    const normalized = normalizeWorkspacePath(path)
    const workspace = get().workspaces.find(
      (item) => normalizeWorkspacePath(item.path) === normalized,
    )
    if (workspace !== undefined) {
      await unwrap(window.dex.workspaces.delete(workspace.workspaceId))
    }
    await get().load()
  },
  moveByPath: async (path, beforePath) => {
    if (window.dex?.workspaces === undefined) throw unavailable()
    const ensure = async (target: string): Promise<WorkspaceView> => {
      const normalized = normalizeWorkspacePath(target)
      const existing = get().workspaces.find(
        (item) => normalizeWorkspacePath(item.path) === normalized,
      )
      if (existing !== undefined) return existing
      const created = (await unwrap(window.dex.workspaces.create(target))) as {
        workspace: WorkspaceView
      }
      return created.workspace
    }
    const source = await ensure(path)
    const anchor = beforePath === undefined ? undefined : await ensure(beforePath)
    await unwrap(
      window.dex.workspaces.insertBefore({
        workspaceId: source.workspaceId,
        ...(anchor === undefined ? {} : { beforeWorkspaceId: anchor.workspaceId }),
      }),
    )
    await get().load()
  },
  restorePath: (path) => {
    const normalized = normalizeWorkspacePath(path)
    const ignored = get().ignoredPaths.filter((item) => item !== normalized)
    writeIgnoredPaths(ignored)
    set({ ignoredPaths: ignored })
  },
  pin: async (sessionId) => {
    if (window.dex?.sessions === undefined) throw unavailable()
    const result = (await unwrap(window.dex.sessions.pin(sessionId))) as {
      pinnedSessionIds: readonly string[]
    }
    set({ pinned: result.pinnedSessionIds })
  },
  unpin: async (sessionId) => {
    if (window.dex?.sessions === undefined) throw unavailable()
    const result = (await unwrap(window.dex.sessions.unpin(sessionId))) as {
      pinnedSessionIds: readonly string[]
    }
    set({ pinned: result.pinnedSessionIds })
  },
  archive: async (sessionId, stopActivity) => {
    if (window.dex?.sessions === undefined) throw unavailable()
    const result = (await unwrap(
      window.dex.sessions.archive({
        sessionId,
        ...(stopActivity === undefined ? {} : { stopActivity }),
      }),
    )) as { archivedSessionIds: readonly string[] }
    set({ archived: result.archivedSessionIds })
  },
  unarchive: async (sessionId) => {
    if (window.dex?.sessions === undefined) throw unavailable()
    const result = (await unwrap(window.dex.sessions.unarchive(sessionId))) as {
      archivedSessionIds: readonly string[]
    }
    set({ archived: result.archivedSessionIds })
  },
  renameSession: async (sessionId, title) => {
    if (window.dex?.sessions === undefined) throw unavailable()
    await unwrap(window.dex.sessions.rename({ sessionId, title }))
  },
  workspaceForPath: (path) => {
    const normalized = normalizeWorkspacePath(path)
    return get().workspaces.find((item) => normalizeWorkspacePath(item.path) === normalized)
  },
}))
