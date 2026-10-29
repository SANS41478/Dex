import type { SessionSummary } from '@dexagent/shared'
import { useEffect, useMemo, useState } from 'react'
import { groupSessionsByWorkspace } from '../../core/session-list'
import {
  normalizeWorkspacePath,
  type WorkspaceRecord,
  workspaceId as workspaceIdForPath,
} from '../../core/workspaces'
import { useRegisteredWorkspaces } from '../../hooks/useRegisteredWorkspaces'
import { useHostWorkspaceStore } from '../../stores/hostWorkspaceStore'
import { useSessionStore } from '../../stores/sessionStore'
import { deleteOrphanSession, deleteWorkspaceCascade } from '../../stores/workspaceActions'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { RenameDialog } from '../ui/RenameDialog'

/**
 * 「工作区」设置页（UI-09）：宿主登记表管理。
 *
 * dsh 语义：删除工作区**只注销登记**，不删目录、不删会话；被删工作区的会话落到
 * 「未分组」。Dex 侧栏按 cwd 推导分组，因此删除时会同时把路径记入本地忽略表
 * （可在这里恢复），否则会话会把已删工作区重新推导出来。
 */
export function WorkspacesSettings() {
  const workspaces = useHostWorkspaceStore((state) => state.workspaces)
  const ignoredPaths = useHostWorkspaceStore((state) => state.ignoredPaths)
  const loadState = useHostWorkspaceStore((state) => state.loadState)
  const loadError = useHostWorkspaceStore((state) => state.error)
  const load = useHostWorkspaceStore((state) => state.load)
  const restorePath = useHostWorkspaceStore((state) => state.restorePath)
  const registeredWorkspaces = useRegisteredWorkspaces()
  const sessions = useSessionStore((state) => state.sessions)
  const sessionWorkspace = useWorkspaceStore((state) => state.sessionWorkspace)
  const loadSessions = useSessionStore((state) => state.load)

  const [renaming, setRenaming] = useState<WorkspaceRecord | null>(null)
  const [removing, setRemoving] = useState<WorkspaceRecord | null>(null)
  const [orphanTarget, setOrphanTarget] = useState<SessionSummary | 'all' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const orphans = useMemo(
    () =>
      groupSessionsByWorkspace({
        visible: sessions,
        registered: registeredWorkspaces,
        sessionWorkspace,
        ignoredPaths,
      }).unassigned,
    [sessions, registeredWorkspaces, sessionWorkspace, ignoredPaths],
  )

  useEffect(() => {
    void load()
    void loadSessions()
  }, [load, loadSessions])

  const addWorkspace = (): void => {
    if (typeof window.dex === 'undefined') {
      setError('添加工作区仅在 Electron 宿主中可用')
      return
    }
    setError(null)
    void window.dex.workspace
      .pick()
      .then((raw) => {
        const value = raw as { ok?: unknown; result?: unknown; error?: { message?: string } }
        if (value.ok !== true) throw new Error(value.error?.message ?? '目录选择失败')
        const picked = value.result as { canceled: boolean; path?: string }
        if (picked.canceled || picked.path === undefined) return undefined
        const path = picked.path
        return (async (): Promise<void> => {
          const created = (await window.dex.workspaces.create(path)) as {
            ok: boolean
            error?: { message?: string }
          }
          if (created.ok !== true) throw new Error(created.error?.message ?? '登记工作区失败')
          await load()
          setNotice(`已添加工作区：${path}`)
        })()
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '添加工作区失败')
      })
  }

  const asRecord = (workspace: {
    readonly workspaceId: string
    readonly path: string
    readonly title: string
  }): WorkspaceRecord => ({
    id: workspaceIdForPath(workspace.path),
    path: normalizeWorkspacePath(workspace.path),
    name: workspace.title,
    lastUsedAt: 0,
  })

  return (
    <div className="workspaces-settings" data-testid="workspaces-settings">
      {loadState === 'loading' && workspaces.length === 0 ? (
        <p className="placeholder">正在读取工作区…</p>
      ) : null}
      {loadError !== null ? <p className="model-error">{loadError}</p> : null}
      {error !== null ? <p className="model-error">{error}</p> : null}
      {notice !== null ? <p className="muted">{notice}</p> : null}

      <section className="settings-section">
        <h3 className="settings-section-title">已登记工作区</h3>
        <p className="muted">
          删除工作区会先归档它下面的全部会话，再注销工作区；文件夹保留，归档可在侧栏恢复。
        </p>
        {workspaces.length === 0 ? (
          <p className="placeholder">暂无登记的工作区——在侧栏「＋」选择目录后会自动登记。</p>
        ) : (
          <ul className="settings-list">
            {workspaces.map((workspace) => (
              <li key={workspace.workspaceId} className="workspace-settings-row">
                <span className="session-row-main">
                  <span className="session-row-title">{workspace.title}</span>
                  <span className="workspace-path mono">{workspace.path}</span>
                </span>
                <span className="muted">{workspace.sessionIds.length} 个会话</span>
                <span className="provider-card-actions">
                  <button
                    type="button"
                    className="graph-chip"
                    onClick={() => setRenaming(asRecord(workspace))}
                    data-testid={`workspace-settings-rename-${workspace.workspaceId}`}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="graph-chip graph-chip-danger"
                    onClick={() => setRemoving(asRecord(workspace))}
                    data-testid={`workspace-settings-remove-${workspace.workspaceId}`}
                  >
                    删除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="graph-chip graph-chip-active"
          onClick={addWorkspace}
          data-testid="workspace-settings-add"
        >
          添加工作区
        </button>
      </section>

      {orphans.length > 0 ? (
        <section className="settings-section">
          <h3 className="settings-section-title">未归属会话</h3>
          <p className="muted">
            这些会话的工作区目录已不存在，无法继续对话，也不会出现在侧栏。彻底删除会移除会话日志，不可恢复。
          </p>
          <ul className="settings-list">
            {orphans.map((session) => (
              <li key={session.sessionId} className="workspace-settings-row">
                <span className="session-row-main">
                  <span className="session-row-title">{session.title}</span>
                  <span className="workspace-path mono">{session.sessionId}</span>
                </span>
                <span className="provider-card-actions">
                  <button
                    type="button"
                    className="graph-chip graph-chip-danger"
                    onClick={() => setOrphanTarget(session)}
                    data-testid={`orphan-delete-${session.sessionId}`}
                  >
                    彻底删除
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="graph-chip graph-chip-danger"
            onClick={() => setOrphanTarget('all')}
            data-testid="orphan-delete-all"
          >
            全部彻底删除
          </button>
        </section>
      ) : null}

      {ignoredPaths.length > 0 ? (
        <section className="settings-section">
          <h3 className="settings-section-title">已隐藏的工作区（本地）</h3>
          <p className="muted">
            这些是历史版本删除工作区时留下的本地忽略路径；恢复后按会话 cwd 重新出现。
          </p>
          <ul className="settings-list">
            {ignoredPaths.map((path) => (
              <li key={path} className="workspace-settings-row">
                <span className="workspace-path mono">{path}</span>
                <span className="provider-card-actions">
                  <button
                    type="button"
                    className="graph-chip"
                    onClick={() => {
                      restorePath(path)
                      setNotice(`已恢复：${path}`)
                    }}
                  >
                    恢复
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {renaming !== null ? (
        <RenameDialog
          title="重命名工作区"
          label="工作区名称"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (value) => {
            try {
              await useHostWorkspaceStore.getState().renameByPath(renaming.path, value)
              return null
            } catch (caught) {
              return caught instanceof Error ? caught.message : '重命名失败'
            }
          }}
        />
      ) : null}
      {removing !== null ? (
        <ConfirmDialog
          title="删除工作区？"
          description={`将把「${removing.name}」从工作区列表中移除，并先归档它下面的会话。文件夹与会话日志都会保留，归档会话可在侧栏恢复。`}
          confirmLabel="删除工作区"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              const count = await deleteWorkspaceCascade(removing)
              setNotice(`已删除工作区：${removing.name}（归档 ${String(count)} 条会话）`)
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : '删除工作区失败')
            }
            setRemoving(null)
          }}
        />
      ) : null}
      {orphanTarget !== null ? (
        <ConfirmDialog
          title="彻底删除未归属会话？"
          description={
            orphanTarget === 'all'
              ? `将物理删除全部 ${String(orphans.length)} 条未归属会话的磁盘日志。此操作不可恢复，附件缓存不会一并清理。`
              : `将物理删除会话「${orphanTarget.title}」的磁盘日志。此操作不可恢复，附件缓存不会一并清理。`
          }
          confirmLabel="彻底删除"
          danger
          onClose={() => setOrphanTarget(null)}
          onConfirm={async () => {
            try {
              const targets = orphanTarget === 'all' ? orphans : [orphanTarget]
              for (const session of targets) {
                await deleteOrphanSession(session.sessionId)
              }
              setNotice(`已彻底删除 ${String(targets.length)} 条未归属会话`)
              await loadSessions()
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : '删除未归属会话失败')
            }
            setOrphanTarget(null)
          }}
        />
      ) : null}
    </div>
  )
}
