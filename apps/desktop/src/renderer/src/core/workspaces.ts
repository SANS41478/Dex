export interface WorkspaceRecord {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly lastUsedAt: number
}

export interface WorkspaceIndex {
  readonly workspaces: readonly WorkspaceRecord[]
  readonly sessionWorkspace: Readonly<Record<string, string>>
}

export const emptyWorkspaceIndex: WorkspaceIndex = {
  workspaces: [],
  sessionWorkspace: {},
}

export function normalizeWorkspacePath(path: string): string {
  const raw = path.trim().replaceAll('\\', '/')
  if (raw === '/') return '/'
  const normalized = raw.replace(/\/+$/, '')
  const windowsPath = /^[A-Za-z]:/.test(normalized) || path.includes('\\')
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`.toLowerCase()
  if (normalized === '') return ''
  return windowsPath ? normalized.toLowerCase() : normalized
}

export function workspaceId(path: string): string {
  return `workspace:${normalizeWorkspacePath(path)}`
}

export function workspaceName(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  const last = normalized.split('/').at(-1)
  return last === undefined || last === '' ? normalized : last
}

export function registerWorkspace(
  index: WorkspaceIndex,
  path: string,
  now = Date.now(),
): { readonly index: WorkspaceIndex; readonly workspace: WorkspaceRecord } {
  const normalizedPath = normalizeWorkspacePath(path)
  const existing = index.workspaces.find((item) => item.path === normalizedPath)
  const workspace: WorkspaceRecord = {
    id: existing?.id ?? workspaceId(normalizedPath),
    path: normalizedPath,
    name: workspaceName(path),
    lastUsedAt: now,
  }
  const workspaces = [
    workspace,
    ...index.workspaces.filter((item) => item.id !== workspace.id),
  ].sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  return { index: { ...index, workspaces }, workspace }
}

export function linkSessionToWorkspace(
  index: WorkspaceIndex,
  sessionId: string,
  workspace: WorkspaceRecord,
): WorkspaceIndex {
  return {
    ...index,
    sessionWorkspace: { ...index.sessionWorkspace, [sessionId]: workspace.id },
  }
}

export function workspaceForSession(
  index: WorkspaceIndex,
  sessionId: string,
): WorkspaceRecord | null {
  const id = index.sessionWorkspace[sessionId]
  return id === undefined ? null : (index.workspaces.find((item) => item.id === id) ?? null)
}

/**
 * 解析持久化的激活工作区 id（独立 key `dex.workspace.active.v1`，存 JSON 字符串）。
 * id 必须指向现存 workspace，否则回退 null——防 localStorage 跨机/删除残留。
 */
export function parseActiveWorkspaceId(
  raw: string | null,
  workspaces: readonly WorkspaceRecord[],
): string | null {
  if (raw === null || raw === '') return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'string') return null
    return workspaces.some((item) => item.id === value) ? value : null
  } catch {
    return null
  }
}

export function serializeActiveWorkspaceId(id: string | null): string {
  return JSON.stringify(id)
}

/**
 * 本地「已删除工作区」忽略表（key `dex.workspaces.ignored.v1`）。
 *
 * 背景：Dex 的侧栏分组按 cwd 推导（FIX-018），而 dsh 的「删除工作区」只是注销登记
 * ——宿主删除后，会话的 cwd 还在，分组会再次把它推导出来。为兑现官方文案
 * 「其会话将显示在未分组下」，删除时把该路径记入本地忽略表，分组与推导都跳过它。
 */
export const WORKSPACES_IGNORED_STORAGE_KEY = 'dex.workspaces.ignored.v1'

export function parseIgnoredPaths(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value
      .filter((item): item is string => typeof item === 'string' && item !== '')
      .map((path) => normalizeWorkspacePath(path))
  } catch {
    return []
  }
}

export function serializeIgnoredPaths(paths: readonly string[]): string {
  return JSON.stringify([...new Set(paths.map((path) => normalizeWorkspacePath(path)))])
}

export function readIgnoredPaths(): readonly string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return parseIgnoredPaths(localStorage.getItem(WORKSPACES_IGNORED_STORAGE_KEY))
  } catch {
    return []
  }
}

export function writeIgnoredPaths(paths: readonly string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WORKSPACES_IGNORED_STORAGE_KEY, serializeIgnoredPaths(paths))
  } catch {
    // 忽略表丢了只是已删工作区重新出现，不值得报错。
  }
}

export function parseWorkspaceIndex(raw: string | null): WorkspaceIndex {
  if (raw === null || raw === '') return emptyWorkspaceIndex
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return emptyWorkspaceIndex
    const input = value as {
      workspaces?: unknown
      sessionWorkspace?: unknown
    }
    const workspaces = Array.isArray(input.workspaces)
      ? input.workspaces.flatMap((item): WorkspaceRecord[] => {
          if (item === null || typeof item !== 'object') return []
          const record = item as Record<string, unknown>
          if (
            typeof record.id !== 'string' ||
            typeof record.path !== 'string' ||
            typeof record.name !== 'string' ||
            typeof record.lastUsedAt !== 'number'
          ) {
            return []
          }
          return [
            {
              id: record.id,
              path: normalizeWorkspacePath(record.path),
              name: record.name,
              lastUsedAt: record.lastUsedAt,
            },
          ]
        })
      : []
    const sessionWorkspace: Record<string, string> =
      input.sessionWorkspace !== null &&
      typeof input.sessionWorkspace === 'object' &&
      !Array.isArray(input.sessionWorkspace)
        ? Object.fromEntries(
            Object.entries(input.sessionWorkspace as Record<string, unknown>).flatMap(
              ([sessionId, workspaceId]) =>
                sessionId.length > 0 && typeof workspaceId === 'string'
                  ? [[sessionId, workspaceId] as const]
                  : [],
            ),
          )
        : {}
    return { workspaces, sessionWorkspace }
  } catch {
    return emptyWorkspaceIndex
  }
}
