import type { SessionSummary } from '@dexagent/shared'
import { type DragEvent, useState } from 'react'
import { relativeTime } from '../../core/relative-time'
import type { ArchivedFilter, WorkspaceSessionGroup } from '../../core/session-list'
import type { WorkspaceRecord } from '../../core/workspaces'
import { Icon } from '../ui/Icon'

/**
 * 侧栏浏览器：**结构与交互照抄 dsh**（`F:\DSH\deepseek-harness\packages\client\ui-workspace`）。
 *
 * 为什么层级感不靠缩进：dsh 的工作区头与它自己的会话行左内边距完全相同
 * （`Rows.module.css:8`，`calc(8px + depth*12px)`，只有嵌套子工作区再 +12px），
 * 它靠的是这几条差异，本组件逐条照做：
 * 1. 工作区行 = **文件夹图标**（hover 时换成 chevron）+ 仅标题 —— 行内**不显示路径**（放 `title` 悬停卡）与**计数**；
 *    dsh 的 `Rows.module.css:99` 注释原话是 "…after removing the session-count subtitle"，计数副标题是刻意移除的。
 * 2. 会话行 = **状态点** + 标题 + 尾部相对时间（hover 时让位给操作按钮）。
 * 3. 分组可折叠（`role="treeitem"` + `aria-expanded`），折叠态持久化。
 * 4. 行高 34 / 32px、组间距 4px、组内 2px、单组超出 5 条出「展开其余 N 个会话」。
 */

/** 单组默认可见会话数；dsh 的 `sessionOverflowButton` 承担同一职责。 */
const SESSION_PREVIEW_LIMIT = 5

export interface SessionRowActions {
  readonly onSelect: (sessionId: string, workspaceId: string) => void
  /** 在该工作区中新建会话（显式绑定，不再走全局继承链）。 */
  readonly onCreateSession: (workspaceId: string) => void
  readonly onTogglePinned: (sessionId: string) => void
  /** 折叠 / 展开某个工作区分组。 */
  readonly onToggleWorkspaceGroup: (workspaceId: string) => void
  /** 组内手动排序（UI-06b）：把 source 拖到 target 的前/后。 */
  readonly onReorderSession: (
    accountKey: string,
    sourceId: string,
    targetId: string,
    half: 'before' | 'after',
  ) => void
  /** 清除全部账号的手动顺序，回到默认排序。 */
  readonly onResetOrder: () => void
  /** 会话重命名（宿主 `session/title` 事件；UI-09）。 */
  readonly onRenameSession: (session: SessionSummary) => void
  /** 删除会话 = 归档（宿主 workspace 门域；可在归档过滤中恢复）。 */
  readonly onDeleteSession: (sessionId: string) => void
  readonly onUnarchiveSession: (sessionId: string) => void
  /** 已归档会话不可打开：点击时给出解释。 */
  readonly onArchivedSessionBlocked: (sessionId: string) => void
  /** 工作区重命名 / 删除登记（删除不删目录与会话）。 */
  readonly onRenameWorkspace: (workspace: WorkspaceRecord) => void
  readonly onDeleteWorkspace: (workspace: WorkspaceRecord) => void
  /** 选目录并登记为新工作区。 */
  readonly onAddWorkspace: () => void
  /** 工作区拖拽排序（顺序写宿主 `workspaces/insertBefore`）。 */
  readonly onReorderWorkspace: (
    sourceKey: string,
    targetKey: string,
    half: 'before' | 'after',
  ) => void
}

export interface SessionListProps {
  /** 顶部 sectionHeader 文案：分组模式是「工作区」，单列模式是「会话」（dsh 同名键）。 */
  readonly sectionLabel: string
  readonly groups: readonly WorkspaceSessionGroup[]
  readonly collapsedIds: readonly string[]
  readonly pinned: readonly string[]
  readonly runningSessionIds: readonly string[]
  readonly unreadSessionIds: readonly string[]
  readonly activeSessionId: string | null
  readonly selectedHistoryId: string | null
  /** 任一账号存在手动顺序时，sectionHeader 显示「恢复默认排序」。 */
  readonly hasManualOrder: boolean
  /** 宿主权威的归档集合与可见性（default 隐藏 / show 混排 / only 只看归档）。 */
  readonly archivedIds: readonly string[]
  readonly archivedFilter: ArchivedFilter
  readonly onArchivedFilterChange: (filter: ArchivedFilter) => void
  readonly actions: SessionRowActions
}

/** 一次会话行拖拽的瞬时状态（不落盘；落盘的是拖放结果）。 */
interface SessionDragState {
  readonly accountKey: string
  readonly sessionId: string
  /** 源行拖起时是否置顶；只有同一块内的行才接受 drop（dsh `sessionDragOrder` 同判据）。 */
  readonly pinned: boolean
  readonly over: { readonly id: string; readonly half: 'before' | 'after' } | null
}

/** 会话行的原生拖放接线（HTML5 dnd，dsh 同方案）。 */
interface SessionRowDnd {
  readonly draggable: boolean
  readonly marker: 'before' | 'after' | null
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void
  readonly onDrop: (event: DragEvent<HTMLElement>) => void
  readonly onDragEnd: () => void
}

function halfOf(event: DragEvent<HTMLElement>): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

const STATUS_LABEL: Record<SessionSummary['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  unknown: '未知',
}

function SessionRow(input: {
  readonly session: SessionSummary
  readonly workspaceId: string
  readonly accountKey: string
  readonly dnd: SessionRowDnd
  readonly props: SessionListProps
  readonly onMenu: (event: React.MouseEvent<HTMLElement>) => void
}) {
  const { session, workspaceId, dnd, props } = input
  const active =
    props.activeSessionId === session.sessionId || props.selectedHistoryId === session.sessionId
  const pinned = props.pinned.includes(session.sessionId)
  const running = props.runningSessionIds.includes(session.sessionId)
  const unread = props.unreadSessionIds.includes(session.sessionId)
  const archived = props.archivedIds.includes(session.sessionId)
  // 空白会话（dsh 的 New Session 占位行）没有时间戳（`Rows.tsx:500-505`）。
  const time = session.blank === true ? null : relativeTime(session.updatedAt)
  return (
    <li className="wsb-item">
      <button
        type="button"
        className={`session-row wsb-session-row${active ? ' wsb-row-active' : ''}${
          archived ? ' wsb-row-archived' : ''
        }${dnd.marker === null ? '' : ` wsb-drop-${dnd.marker}`}`}
        role="treeitem"
        aria-selected={active}
        aria-description={archived ? '已归档：取消归档后可打开' : undefined}
        draggable={dnd.draggable}
        onDragStart={dnd.onDragStart}
        onDragOver={dnd.onDragOver}
        onDrop={dnd.onDrop}
        onDragEnd={dnd.onDragEnd}
        onClick={() => {
          if (archived) {
            props.actions.onArchivedSessionBlocked(session.sessionId)
            return
          }
          props.actions.onSelect(session.sessionId, workspaceId)
        }}
        data-testid={`session-${session.sessionId}`}
      >
        <span
          className={`wsb-slot wsb-dot wsb-dot-${session.status}`}
          aria-hidden="true"
          title={STATUS_LABEL[session.status]}
        />
        <span className="session-row-title">
          {session.title}
          {running ? (
            <span className="session-row-flag" data-testid={`session-running-${session.sessionId}`}>
              运行中
            </span>
          ) : null}
        </span>
        <span className="wsb-row-actions">
          {unread ? (
            <span
              className="session-row-unread"
              title="该会话在后台完成，点击查看"
              data-testid={`session-unread-${session.sessionId}`}
            />
          ) : null}
          {/* 静息态显示时间，hover 时让位给操作按钮（dsh `Rows.module.css:279`） */}
          {time === null ? null : <span className="wsb-time">{time}</span>}
          <button
            type="button"
            className="wsb-icon-button"
            aria-label={pinned ? '取消置顶' : '置顶'}
            onClick={(event) => {
              event.stopPropagation()
              props.actions.onTogglePinned(session.sessionId)
            }}
          >
            {pinned ? '◆' : '◇'}
          </button>
          <button
            type="button"
            className="wsb-icon-button"
            aria-label="更多操作"
            onClick={(event) => {
              event.stopPropagation()
              input.onMenu(event)
            }}
            data-testid={`session-menu-${session.sessionId}`}
          >
            ⋯
          </button>
        </span>
      </button>
    </li>
  )
}

interface GroupView {
  readonly key: string
  readonly workspaceId: string
  readonly label: string
  readonly path: string
  readonly containsCurrent: boolean
  readonly sessions: readonly SessionSummary[]
}

type RowMenu =
  | {
      readonly kind: 'session'
      readonly session: SessionSummary
      readonly x: number
      readonly y: number
    }
  | {
      readonly kind: 'workspace'
      readonly workspace: WorkspaceRecord
      readonly x: number
      readonly y: number
    }

export function SessionList(props: SessionListProps) {
  // 「展开其余 N 个会话」是瞬时状态（dsh 也只挂在浏览器本地），不落盘。
  const [expandedGroups, setExpandedGroups] = useState<readonly string[]>([])
  // 拖拽中的插入标记同样是瞬时状态；落盘的只有 drop 结果（UI-06b）。
  const [drag, setDrag] = useState<SessionDragState | null>(null)
  // 行操作菜单（重命名/归档/删除工作区）：瞬时状态。
  const [menu, setMenu] = useState<RowMenu | null>(null)
  // 工作区行拖拽（UI-09 收口）：与会话拖拽互不干扰（各自独立状态）。
  const [workspaceDrag, setWorkspaceDrag] = useState<{
    readonly sourceKey: string
    readonly over: { readonly key: string; readonly half: 'before' | 'after' } | null
  } | null>(null)

  const openSessionMenu = (event: React.MouseEvent<HTMLElement>, session: SessionSummary): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      kind: 'session',
      session,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
      y: rect.bottom + 4,
    })
  }
  const openWorkspaceMenu = (event: React.MouseEvent<HTMLElement>, workspaceId: string): void => {
    const workspace = props.groups.find((item) => item.workspace.id === workspaceId)?.workspace
    if (workspace === undefined) return
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      kind: 'workspace',
      workspace,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
      y: rect.bottom + 4,
    })
  }

  const dndFor = (session: SessionSummary, accountKey: string, pinned: boolean): SessionRowDnd => {
    // 空白占位行与归档行都不可拖（dsh：`!row.blank && !row.archived`）。
    const draggable = session.blank !== true && !props.archivedIds.includes(session.sessionId)
    const marker =
      drag !== null && drag.accountKey === accountKey && drag.over?.id === session.sessionId
        ? drag.over.half
        : null
    return {
      draggable,
      marker,
      onDragStart: (event) => {
        if (!draggable) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', session.sessionId)
        setDrag({ accountKey, sessionId: session.sessionId, pinned, over: null })
      },
      onDragEnd: () => setDrag(null),
      onDragOver: (event) => {
        if (
          !draggable ||
          drag === null ||
          drag.accountKey !== accountKey ||
          drag.pinned !== pinned ||
          drag.sessionId === session.sessionId
        ) {
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const half = halfOf(event)
        setDrag((current) =>
          current === null ? null : { ...current, over: { id: session.sessionId, half } },
        )
      },
      onDrop: (event) => {
        if (
          drag === null ||
          drag.accountKey !== accountKey ||
          drag.pinned !== pinned ||
          drag.sessionId === session.sessionId
        ) {
          return
        }
        event.preventDefault()
        const half = halfOf(event)
        const sourceId = drag.sessionId
        setDrag(null)
        props.actions.onReorderSession(accountKey, sourceId, session.sessionId, half)
      },
    }
  }

  const views: readonly GroupView[] = props.groups.map((group) => ({
    key: group.workspace.id,
    workspaceId: group.workspace.id,
    label: group.workspace.name,
    path: group.workspace.path,
    containsCurrent:
      props.activeSessionId !== null &&
      group.sessions.some((session) => session.sessionId === props.activeSessionId),
    sessions: group.sessions,
  }))

  return (
    <div className="wsb" role="tree" aria-label={props.sectionLabel}>
      <div className="wsb-section-header">
        <span>{props.sectionLabel}</span>
        <span className="wsb-section-actions">
          {props.archivedIds.length > 0 || props.archivedFilter !== 'default' ? (
            <button
              type="button"
              className="wsb-order-reset"
              title="归档会话可见性：隐藏 / 显示 / 仅看归档"
              data-testid="sidebar-archived-filter"
              onClick={() =>
                props.onArchivedFilterChange(
                  props.archivedFilter === 'default'
                    ? 'show'
                    : props.archivedFilter === 'show'
                      ? 'only'
                      : 'default',
                )
              }
            >
              {props.archivedFilter === 'default'
                ? `归档：隐藏（${String(props.archivedIds.length)}）`
                : props.archivedFilter === 'show'
                  ? '归档：显示'
                  : '归档：仅看'}
            </button>
          ) : null}
          {props.hasManualOrder ? (
            <button
              type="button"
              className="wsb-order-reset"
              data-testid="sidebar-order-reset"
              onClick={props.actions.onResetOrder}
            >
              恢复默认排序
            </button>
          ) : null}
          <button
            type="button"
            className="wsb-icon-button"
            aria-label="添加工作区"
            title="添加工作区"
            data-testid="workspace-add"
            onClick={props.actions.onAddWorkspace}
          >
            ＋
          </button>
        </span>
      </div>
      {views.map((view) => {
        const collapsed = props.collapsedIds.includes(view.key)
        const revealed = expandedGroups.includes(view.key)
        // 空白占位行不计入「展开其余 N 个」配额（dsh `WorkspaceBrowser.tsx:46-57`）。
        const blankRows = view.sessions.filter((session) => session.blank === true)
        const ordinary = view.sessions.filter((session) => session.blank !== true)
        const limit = revealed ? ordinary.length : SESSION_PREVIEW_LIMIT
        const hiddenCount = Math.max(0, ordinary.length - limit)
        const workspaceDraggable = true
        const workspaceMarker =
          workspaceDrag !== null && workspaceDrag.over?.key === view.key
            ? workspaceDrag.over.half
            : null
        return (
          <section
            key={view.key}
            className={`wsb-group${view.containsCurrent ? ' wsb-group-current' : ''}`}
            data-testid={`workspace-group-${view.workspaceId}`}
          >
            <div className="wsb-workspace-row" title={view.path}>
              <button
                type="button"
                className={`wsb-row-main${
                  workspaceMarker === null ? '' : ` wsb-drop-${workspaceMarker}`
                }`}
                role="treeitem"
                aria-expanded={!collapsed}
                draggable={workspaceDraggable}
                data-testid={`workspace-row-${view.workspaceId}`}
                onDragStart={(event) => {
                  if (!workspaceDraggable) return
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', view.key)
                  setWorkspaceDrag({ sourceKey: view.key, over: null })
                }}
                onDragEnd={() => setWorkspaceDrag(null)}
                onDragOver={(event) => {
                  if (
                    !workspaceDraggable ||
                    workspaceDrag === null ||
                    workspaceDrag.sourceKey === view.key
                  ) {
                    return
                  }
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const rect = event.currentTarget.getBoundingClientRect()
                  const half = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  setWorkspaceDrag((current) =>
                    current === null ? null : { ...current, over: { key: view.key, half } },
                  )
                }}
                onDrop={(event) => {
                  if (
                    !workspaceDraggable ||
                    workspaceDrag === null ||
                    workspaceDrag.sourceKey === view.key
                  ) {
                    return
                  }
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const half = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  const sourceKey = workspaceDrag.sourceKey
                  setWorkspaceDrag(null)
                  props.actions.onReorderWorkspace(sourceKey, view.key, half)
                }}
                onClick={() => {
                  props.actions.onToggleWorkspaceGroup(view.key)
                }}
              >
                <span
                  className={`wsb-slot wsb-folder${view.containsCurrent ? ' wsb-folder-active' : ''}`}
                >
                  <Icon name="workspace" size={14} />
                </span>
                <span className="wsb-slot wsb-chev" aria-hidden="true">
                  <Icon
                    name="chevron-right"
                    size={12}
                    className={collapsed ? '' : 'wsb-arrow-open'}
                  />
                </span>
                <span className="session-row-title">{view.label}</span>
              </button>
              <span className="wsb-row-actions">
                <span className="wsb-time">
                  {relativeTime(
                    view.sessions.reduce(
                      (latest, session) => Math.max(latest, session.updatedAt ?? 0),
                      0,
                    ) || undefined,
                  )}
                </span>
                <button
                  type="button"
                  className="wsb-icon-button wsb-new-session"
                  aria-label={`在「${view.label}」中新建会话`}
                  title="新建会话"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.actions.onCreateSession(view.workspaceId)
                  }}
                  data-testid={`workspace-new-session-${view.workspaceId}`}
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="wsb-icon-button"
                  aria-label="工作区操作"
                  onClick={(event) => {
                    event.stopPropagation()
                    openWorkspaceMenu(event, view.workspaceId)
                  }}
                  data-testid={`workspace-menu-${view.workspaceId}`}
                >
                  ⋯
                </button>
              </span>
            </div>
            {collapsed ? null : (
              <ul className="wsb-sessions">
                {view.sessions.length === 0 ? (
                  <li className="wsb-empty">暂无会话</li>
                ) : (
                  <>
                    {[...blankRows, ...ordinary.slice(0, limit)].map((session) => (
                      <SessionRow
                        key={session.sessionId}
                        session={session}
                        workspaceId={view.workspaceId}
                        accountKey={view.key}
                        dnd={dndFor(session, view.key, props.pinned.includes(session.sessionId))}
                        props={props}
                        onMenu={(event) => openSessionMenu(event, session)}
                      />
                    ))}
                    {hiddenCount > 0 ? (
                      <li>
                        <button
                          type="button"
                          className="wsb-session-overflow"
                          onClick={() => setExpandedGroups((ids) => [...ids, view.key])}
                        >
                          展开其余 {hiddenCount} 个会话
                        </button>
                      </li>
                    ) : null}
                  </>
                )}
              </ul>
            )}
          </section>
        )
      })}
      {views.length === 0 ? (
        <p className="placeholder">暂无工作区，先添加一个工作区。</p>
      ) : views.every((view) => view.sessions.length === 0) ? (
        <p className="placeholder">暂无已持久化会话</p>
      ) : null}
      {menu !== null ? (
        <>
          <button
            type="button"
            className="wsb-menu-backdrop"
            aria-label="关闭菜单"
            onClick={() => setMenu(null)}
          />
          <div
            className="wsb-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            data-testid="sidebar-menu"
          >
            {menu.kind === 'session' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null)
                    props.actions.onRenameSession(menu.session)
                  }}
                >
                  重命名
                </button>
                {props.archivedIds.includes(menu.session.sessionId) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null)
                      props.actions.onUnarchiveSession(menu.session.sessionId)
                    }}
                  >
                    取消归档
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="wsb-menu-danger"
                    title="删除会归档该会话，可在归档过滤中恢复"
                    onClick={() => {
                      setMenu(null)
                      props.actions.onDeleteSession(menu.session.sessionId)
                    }}
                  >
                    删除会话
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null)
                    props.actions.onCreateSession(menu.workspace.id)
                  }}
                >
                  新建会话
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null)
                    props.actions.onRenameWorkspace(menu.workspace)
                  }}
                >
                  重命名工作区
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="wsb-menu-danger"
                  onClick={() => {
                    setMenu(null)
                    props.actions.onDeleteWorkspace(menu.workspace)
                  }}
                >
                  删除工作区
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
