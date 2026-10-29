import type { WorkspaceView } from '@dexagent/shared'
import { useMemo } from 'react'
import {
  normalizeWorkspacePath,
  type WorkspaceRecord,
  workspaceId as workspaceIdForPath,
} from '../core/workspaces'
import { useHostWorkspaceStore } from '../stores/hostWorkspaceStore'
import { useSessionStore } from '../stores/sessionStore'
import { useWorkspaceStore } from '../stores/workspaceStore'

export function useRegisteredWorkspaces(): readonly WorkspaceRecord[] {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const hostWorkspaces = useHostWorkspaceStore((state) => state.workspaces)
  const hostWorkspaceIds = useHostWorkspaceStore((state) => state.workspaceIds)
  const sessions = useSessionStore((state) => state.sessions)

  return useMemo(() => {
    const byId = new Map<string, WorkspaceRecord>()
    for (const workspace of workspaces) byId.set(workspace.id, workspace)
    const hostByUuid = new Map<string, WorkspaceView>(
      hostWorkspaces.map((host) => [host.workspaceId, host]),
    )
    const ordered: WorkspaceRecord[] = []
    const seen = new Set<string>()
    for (const workspaceId of hostWorkspaceIds) {
      const host = hostByUuid.get(workspaceId)
      if (host === undefined) continue
      const id = workspaceIdForPath(host.path)
      if (seen.has(id)) continue
      seen.add(id)
      const local = byId.get(id)
      ordered.push({
        id,
        path: normalizeWorkspacePath(host.path),
        name: host.title,
        lastUsedAt: local?.lastUsedAt ?? host.updatedAt ?? 0,
      })
    }
    const sessionPaths = new Set(
      sessions.flatMap((session) =>
        session.cwd === undefined ? [] : [normalizeWorkspacePath(session.cwd)],
      ),
    )
    const rest = [...byId.values()]
      .filter((workspace) => !seen.has(workspace.id) && sessionPaths.has(workspace.path))
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    return [...ordered, ...rest]
  }, [workspaces, hostWorkspaces, hostWorkspaceIds, sessions])
}
