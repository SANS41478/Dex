import { useState } from 'react'
import {
  connectionStatusLabel,
  connectionStatusTone,
  hostStatusLabel,
  hostStatusTone,
} from '../../core/status-labels'
import { SessionPanel } from '../../panels/SessionPanel'
import { useConnectionStore } from '../../stores/connectionStore'
import { useHostStore } from '../../stores/hostStore'
import { useNavigationStore } from '../../stores/navigationStore'
import { Icon } from '../ui/Icon'

export function AppSidebar() {
  const [search, setSearch] = useState('')
  const connection = useConnectionStore((state) => state.status)
  const hostPhase = useHostStore((state) => state.phase)
  const hostDetail = useHostStore((state) => state.detail)
  const openSettings = useNavigationStore((state) => state.openSettings)
  // 工作区入口收敛（C-4）：分组列表（SessionPanel 内）是唯一入口，
  // 顶部的裸 <select> 已移除；激活态持久化见 workspaceStore。
  return (
    <aside className="app-sidebar" data-testid="app-sidebar">
      <div className="sidebar-tools">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索工作区 / 会话"
          aria-label="搜索工作区和会话"
          data-testid="sidebar-search"
        />
      </div>
      <SessionPanel searchQuery={search} />
      {/* 宿主与连接状态原先放在被隐藏的面板头里（界面上看不到），这里移到底部状态行 */}
      <footer className="sidebar-user-area">
        <span
          className={`status status-${hostStatusTone(hostPhase)}`}
          title={hostDetail ?? undefined}
          data-testid="host-status"
        >
          <span className="status-dot" />
          {hostStatusLabel(hostPhase)}
        </span>
        <span
          className={`status status-${connectionStatusTone(connection)}`}
          data-testid="connection-status"
        >
          <span className="status-dot" />
          {connectionStatusLabel(connection)}
        </span>
        <button
          type="button"
          className="sidebar-settings"
          aria-label="设置"
          onClick={openSettings}
          data-testid="settings-open"
        >
          <Icon name="settings" size={14} />
        </button>
      </footer>
    </aside>
  )
}
