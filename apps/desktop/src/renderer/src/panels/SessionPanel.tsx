import type { SessionSummary } from '@dexagent/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SessionList } from '../components/sessions/SessionList'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { RenameDialog } from '../components/ui/RenameDialog'
import {
  type ArchivedFilter,
  groupSessionsByWorkspace,
  selectVisibleSessions,
} from '../core/session-list'
import { readCollapsedIds, toggleCollapsedId, writeCollapsedIds } from '../core/sidebar-collapse'
import {
  readOrderMap,
  reorderSession,
  type SidebarOrderMap,
  withSessionOrder,
  writeOrderMap,
} from '../core/sidebar-order'
import type { WorkspaceRecord } from '../core/workspaces'
import { useRegisteredWorkspaces } from '../hooks/useRegisteredWorkspaces'
import { useChatStore } from '../stores/chatStore'
import { useHostWorkspaceStore } from '../stores/hostWorkspaceStore'
import { useSessionStatusStore } from '../stores/sessionStatusStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSessionUnreadStore } from '../stores/sessionUnreadStore'
import { useTraceStore } from '../stores/traceStore'
import {
  addWorkspaceAndCreateSession,
  archiveSession,
  deleteWorkspaceCascade,
} from '../stores/workspaceActions'
import { useWorkspaceStore } from '../stores/workspaceStore'

export function SessionPanel({ searchQuery = '' }: { readonly searchQuery?: string }) {
  const turns = useTraceStore((state) => state.turns)
  const traceViewMode = useTraceStore((state) => state.viewMode)
  const timeTravelStepId = useTraceStore((state) => state.timeTravelStepId)
  const replaySessionId = useTraceStore((state) => state.replaySessionId)
  const clearTrace = useTraceStore((state) => state.clear)
  const history = useSessionStore((state) => state.sessions)
  const historyIndex = useSessionStore((state) => state.index)
  const selectedHistoryId = useSessionStore((state) => state.selectedId)
  const historyLoading = useSessionStore((state) => state.loading)
  const historyError = useSessionStore((state) => state.error)
  const loadHistory = useSessionStore((state) => state.load)
  const replayHistory = useSessionStore((state) => state.replay)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const activateSession = useChatStore((state) => state.activate)
  const createSession = useChatStore((state) => state.newSession)
  const clearChat = useChatStore((state) => state.clear)
  const sessionWorkspace = useWorkspaceStore((state) => state.sessionWorkspace)
  const sessionStatuses = useSessionStatusStore((state) => state.statuses)
  const unreadSessions = useSessionUnreadStore((state) => state.unread)
  const [continuationNotice, setContinuationNotice] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<readonly string[]>(() => readCollapsedIds())
  // 组内手动顺序（UI-06b）：dsh 把 manual order 挂在浏览器本地，我们落 localStorage。
  const [orderByAccount, setOrderByAccount] = useState<SidebarOrderMap>(() => readOrderMap())
  // 归档可见性（UI-09，照 dsh default/show/only）。
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>('default')

  // 宿主权威面（UI-09）：工作区登记 + 归档/置顶集合。
  const registeredWorkspaces = useRegisteredWorkspaces()
  const hostPinned = useHostWorkspaceStore((state) => state.pinned)
  const hostArchived = useHostWorkspaceStore((state) => state.archived)
  const hostIgnoredPaths = useHostWorkspaceStore((state) => state.ignoredPaths)
  const hostLoadState = useHostWorkspaceStore((state) => state.loadState)
  const loadHostWorkspaces = useHostWorkspaceStore((state) => state.load)
  const clearPinned = useSessionStore((state) => state.clearPinned)

  // 重命名 / 删除确认弹窗目标（UI-09）。
  const [renameTarget, setRenameTarget] = useState<
    | { readonly kind: 'session'; readonly session: SessionSummary }
    | { readonly kind: 'workspace'; readonly workspace: WorkspaceRecord }
    | null
  >(null)
  const [confirmTarget, setConfirmTarget] = useState<
    | { readonly kind: 'delete-session'; readonly sessionId: string }
    | { readonly kind: 'delete-workspace'; readonly workspace: WorkspaceRecord }
    | null
  >(null)

  // 折叠态持久化（FIX-019 / UI-06）：dsh 把它挂在浏览器本地，我们落 localStorage。
  useEffect(() => {
    writeCollapsedIds(collapsedIds)
  }, [collapsedIds])

  useEffect(() => {
    writeOrderMap(orderByAccount)
  }, [orderByAccount])

  // 宿主工作区/归档/置顶快照（宿主 ready 前控制通道会自行退避重试）。
  useEffect(() => {
    void loadHostWorkspaces()
  }, [loadHostWorkspaces])

  // 一次性迁移：本地遗留的 pinned 迁到宿主权威集合（幂等，只跑一次）。
  const pinnedMigrated = useRef(false)
  useEffect(() => {
    if (pinnedMigrated.current || hostLoadState !== 'ready') return
    pinnedMigrated.current = true
    const localPinned = useSessionStore.getState().index.pinned
    if (localPinned.length === 0) return
    for (const sessionId of localPinned) {
      void useHostWorkspaceStore
        .getState()
        .pin(sessionId)
        .catch(() => undefined)
    }
    clearPinned()
  }, [hostLoadState, clearPinned])

  const toggleWorkspaceGroup = useCallback((workspaceId: string) => {
    setCollapsedIds((ids) => toggleCollapsedId(ids, workspaceId))
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const readOnlyReplay = traceViewMode === 'replay' || timeTravelStepId !== null

  // 置顶以宿主为准；迁移尚未完成时退回本地遗留集合，避免排序闪变。
  const effectivePinned = hostPinned.length > 0 ? hostPinned : historyIndex.pinned

  // 会话列表的全部筛选/排序/分组都是纯函数（core/session-list.ts），组件只做接线。
  const visibleHistory = useMemo(
    () =>
      selectVisibleSessions({
        sessions: history,
        index: historyIndex,
        query: searchQuery,
        activeSessionId,
        archivedIds: hostArchived,
        archivedFilter,
      }),
    [history, historyIndex, searchQuery, activeSessionId, hostArchived, archivedFilter],
  )
  const { groups, unassigned } = useMemo(
    () =>
      groupSessionsByWorkspace({
        visible: visibleHistory,
        registered: registeredWorkspaces,
        sessionWorkspace,
        query: searchQuery,
        orderByAccount,
        pinnedIds: effectivePinned,
        ignoredPaths: hostIgnoredPaths,
        ...(activeSessionId === null ? {} : { activeSessionId, activeTurns: turns }),
      }),
    [
      visibleHistory,
      registeredWorkspaces,
      sessionWorkspace,
      searchQuery,
      activeSessionId,
      turns,
      orderByAccount,
      effectivePinned,
      hostIgnoredPaths,
    ],
  )
  const selectHistorySession = useCallback(
    (
      sessionIdToOpen: string,
      workspace: { readonly id: string; readonly path: string } | null,
    ): void => {
      if (workspace === null) {
        setContinuationNotice(
          '这条会话记录的工作区目录已不存在或未记录，dsh 无法在其中续聊，只能只读回放。可到「设置 → 工作区 → 未归属会话」清理。',
        )
        clearChat()
        void replayHistory(sessionIdToOpen)
        return
      }
      if (typeof window.dex === 'undefined') {
        clearChat()
        void replayHistory(sessionIdToOpen)
        return
      }
      void activateSession(sessionIdToOpen, workspace.path)
        .then(() => {
          setContinuationNotice(null)
          return replayHistory(sessionIdToOpen, true)
        })
        .catch((error: unknown) => {
          // 历史会话无法继续对话（resume 失败被拒）→ 退化为只读回放。
          setContinuationNotice(
            error instanceof Error ? error.message : '该会话只能只读回放，不能继续对话',
          )
          void replayHistory(sessionIdToOpen)
        })
    },
    [clearChat, replayHistory, activateSession],
  )

  const runningSessionIds = useMemo(
    () =>
      Object.entries(sessionStatuses)
        .filter(([, status]) => status === 'running')
        .map(([id]) => id),
    [sessionStatuses],
  )

  const resolveWorkspace = useCallback(
    (workspaceId: string): WorkspaceRecord | undefined =>
      groups.find((group) => group.workspace.id === workspaceId)?.workspace ??
      registeredWorkspaces.find((workspace) => workspace.id === workspaceId),
    [groups, registeredWorkspaces],
  )

  const listActions = useMemo(
    () => ({
      onSelect: (sessionIdToOpen: string, workspaceId: string) => {
        const workspace = resolveWorkspace(workspaceId)
        if (workspace === undefined) {
          setContinuationNotice('找不到该会话所属工作区')
          return
        }
        selectHistorySession(sessionIdToOpen, workspace)
      },
      onCreateSession: (workspaceId: string) => {
        const workspace = resolveWorkspace(workspaceId)
        if (workspace === undefined) {
          setContinuationNotice('找不到该工作区')
          return
        }
        void createSession(workspace)
          .then(() => loadHistory())
          .catch((error: unknown) => {
            setContinuationNotice(error instanceof Error ? error.message : '新建会话失败')
          })
      },
      onTogglePinned: (sessionId: string) => {
        const host = useHostWorkspaceStore.getState()
        const pinnedNow = host.pinned.includes(sessionId)
        void (pinnedNow ? host.unpin(sessionId) : host.pin(sessionId)).catch((error: unknown) => {
          setContinuationNotice(error instanceof Error ? error.message : '置顶操作失败')
        })
      },
      onRenameSession: (session: SessionSummary) => {
        setRenameTarget({ kind: 'session', session })
      },
      onDeleteSession: (sessionId: string) => {
        void archiveSession(sessionId).catch((error: unknown) => {
          const code = (error as { code?: string }).code
          if (code === 'SESSION_ACTIVE') {
            setConfirmTarget({ kind: 'delete-session', sessionId })
            return
          }
          setContinuationNotice(error instanceof Error ? error.message : '删除会话失败')
        })
      },
      onUnarchiveSession: (sessionId: string) => {
        void useHostWorkspaceStore
          .getState()
          .unarchive(sessionId)
          .catch((error: unknown) => {
            setContinuationNotice(error instanceof Error ? error.message : '取消归档失败')
          })
      },
      onArchivedSessionBlocked: () => {
        setContinuationNotice('这条会话已归档，取消归档后即可打开。')
      },
      onRenameWorkspace: (workspace: WorkspaceRecord) => {
        setRenameTarget({ kind: 'workspace', workspace })
      },
      onDeleteWorkspace: (workspace: WorkspaceRecord) => {
        setConfirmTarget({ kind: 'delete-workspace', workspace })
      },
      onAddWorkspace: () => {
        void addWorkspaceAndCreateSession()
          .then(() => loadHistory())
          .catch((error: unknown) => {
            setContinuationNotice(error instanceof Error ? error.message : '添加工作区失败')
          })
      },
      onToggleWorkspaceGroup: toggleWorkspaceGroup,
      onReorderSession: (
        accountKey: string,
        sourceId: string,
        targetId: string,
        half: 'before' | 'after',
      ) => {
        const current =
          groups
            .find((group) => group.workspace.id === accountKey)
            ?.sessions.map((session) => session.sessionId) ?? []
        const next = reorderSession({ order: current, sourceId, targetId, half })
        if (next === null) return
        setOrderByAccount((map) => withSessionOrder(map, accountKey, next))
      },
      onResetOrder: () => {
        setOrderByAccount({})
      },
      onReorderWorkspace: (sourceKey: string, targetKey: string, half: 'before' | 'after') => {
        if (sourceKey === targetKey) return
        const records = registeredWorkspaces
        const source = records.find((item) => item.id === sourceKey)
        const target = records.find((item) => item.id === targetKey)
        if (source === undefined || target === undefined) return
        const without = records.map((item) => item.id).filter((id) => id !== source.id)
        const targetIndex = without.indexOf(target.id)
        if (targetIndex === -1) return
        const anchorId = half === 'before' ? target.id : (without[targetIndex + 1] ?? undefined)
        const anchor =
          anchorId === undefined ? undefined : records.find((item) => item.id === anchorId)
        void useHostWorkspaceStore
          .getState()
          .moveByPath(source.path, anchor?.path)
          .catch((error: unknown) => {
            setContinuationNotice(error instanceof Error ? error.message : '调整工作区顺序失败')
          })
      },
    }),
    [
      selectHistorySession,
      resolveWorkspace,
      createSession,
      toggleWorkspaceGroup,
      groups,
      loadHistory,
      registeredWorkspaces,
    ],
  )

  const submitRename = useCallback(
    async (value: string): Promise<string | null> => {
      if (renameTarget === null) return null
      try {
        if (renameTarget.kind === 'session') {
          await useHostWorkspaceStore
            .getState()
            .renameSession(renameTarget.session.sessionId, value)
          await loadHistory()
        } else {
          await useHostWorkspaceStore.getState().renameByPath(renameTarget.workspace.path, value)
        }
        return null
      } catch (error) {
        return error instanceof Error ? error.message : '重命名失败'
      }
    },
    [renameTarget, loadHistory],
  )

  const confirmDialogAction = useCallback(async (): Promise<void> => {
    if (confirmTarget === null) return
    try {
      if (confirmTarget.kind === 'delete-session') {
        await archiveSession(confirmTarget.sessionId, true)
      } else {
        const count = await deleteWorkspaceCascade(confirmTarget.workspace)
        setContinuationNotice(`已删除工作区，并归档 ${String(count)} 条会话`)
      }
      setConfirmTarget(null)
    } catch (error) {
      setConfirmTarget(null)
      setContinuationNotice(error instanceof Error ? error.message : '操作失败')
    }
  }, [confirmTarget])

  return (
    <section className="panel" data-testid="panel-session">
      <div className="panel-body">
        <div className="session-history" data-testid="session-history">
          {historyLoading && history.length === 0 ? (
            <p className="placeholder">正在读取会话历史…</p>
          ) : null}
          {historyError !== null ? <p className="model-error">{historyError}</p> : null}
          {!historyLoading && visibleHistory.length === 0 && history.length > 0 ? (
            <p className="placeholder">暂无已持久化会话</p>
          ) : null}
          <SessionList
            sectionLabel="工作区"
            groups={groups}
            collapsedIds={collapsedIds}
            pinned={effectivePinned}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessions}
            activeSessionId={activeSessionId}
            selectedHistoryId={selectedHistoryId}
            hasManualOrder={Object.keys(orderByAccount).length > 0}
            archivedIds={hostArchived}
            archivedFilter={archivedFilter}
            onArchivedFilterChange={setArchivedFilter}
            actions={listActions}
          />
          {unassigned.length > 0 ? (
            <p className="placeholder" data-testid="session-orphan-notice">
              有 {unassigned.length} 条历史会话无法定位工作区，已从列表隐藏；请到「设置 → 工作区 →
              未归属会话」归档或彻底删除。
            </p>
          ) : null}
          {continuationNotice !== null ? (
            <p className="placeholder" data-testid="session-continuation-notice">
              {continuationNotice}
            </p>
          ) : null}
          {readOnlyReplay && replaySessionId !== null ? (
            <div className="session-replay" data-testid="session-replay">
              <div className="session-history-head">
                <span className="muted">只读回放 · {replaySessionId}</span>
                <button
                  type="button"
                  className="graph-chip"
                  onClick={() => {
                    setContinuationNotice(null)
                    clearTrace()
                  }}
                >
                  返回实时
                </button>
              </div>
              <ul className="session-task-list">
                {turns.map((turn) => (
                  <li key={turn.id}>
                    <span
                      className={`dot dot-${turn.status === 'failed' ? 'failed' : turn.status === 'running' ? 'running' : 'success'}`}
                    />
                    <span>{turn.userMessage || '（无提问文本）'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {typeof window.dex === 'undefined' ? (
          <p className="model-error">聊天与工作区仅在 Electron 宿主中可执行。</p>
        ) : null}
      </div>
      {renameTarget !== null ? (
        <RenameDialog
          title={renameTarget.kind === 'session' ? '重命名会话' : '重命名工作区'}
          label={renameTarget.kind === 'session' ? '会话标题' : '工作区名称'}
          initial={
            renameTarget.kind === 'session'
              ? renameTarget.session.title
              : renameTarget.workspace.name
          }
          onClose={() => setRenameTarget(null)}
          onSubmit={submitRename}
        />
      ) : null}
      {confirmTarget !== null ? (
        <ConfirmDialog
          title={confirmTarget.kind === 'delete-session' ? '停止并删除此会话？' : '删除工作区？'}
          description={
            confirmTarget.kind === 'delete-session'
              ? '该会话还有正在运行的工作（回合 / 子代理 / 任务 / 计划）。继续将先停止这些工作，然后归档；可在归档过滤中恢复。'
              : `将把「${confirmTarget.workspace.name}」从工作区列表中移除，并先归档它下面的 ${
                  groups.find((group) => group.workspace.id === confirmTarget.workspace.id)
                    ?.sessions.length ?? 0
                } 条会话。文件夹保留，归档会话可在归档过滤中恢复。`
          }
          confirmLabel={confirmTarget.kind === 'delete-session' ? '停止并删除' : '删除工作区'}
          danger
          onConfirm={confirmDialogAction}
          onClose={() => setConfirmTarget(null)}
        />
      ) : null}
    </section>
  )
}
