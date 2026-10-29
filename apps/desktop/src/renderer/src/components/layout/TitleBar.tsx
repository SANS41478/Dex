import { useEffect, useState } from 'react'
import type { IconName } from '../../core/icons.generated'
import { workspaceName } from '../../core/workspaces'
import { type ThemePreference, useTheme } from '../../hooks/useTheme'
import { useChatStore } from '../../stores/chatStore'
import { useNavigationStore } from '../../stores/navigationStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { Icon } from '../ui/Icon'
import { ShortcutsDialog } from './ShortcutsDialog'

/** 三态外观在 TitleBar 上的图标与文案（切换顺序见 useTheme 的 CYCLE） */
const THEME_ICON: Record<ThemePreference, IconName> = {
  system: 'theme-system',
  light: 'theme-light',
  dark: 'theme-dark',
}

const THEME_LABEL: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

export interface TitleBarProps {
  readonly onNewChat: () => void
  readonly onToggleSidebar: () => void
  readonly onToggleObserver: () => void
  readonly onResetLayout: () => void
  readonly observerVisible: boolean
}

export function TitleBar({
  onNewChat,
  onToggleSidebar,
  onToggleObserver,
  onResetLayout,
  observerVisible,
}: TitleBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /*
   * 最大化状态：**以主进程为真源**。
   * 原实现的按钮 `aria-label` 是写死的「最大化」，点了之后标签也不变，
   * 可访问名与实际状态脱节；更要紧的是主进程 toggle 用 `isMaximized()` 决定方向，
   * 一旦标志与视觉状态不一致，按钮就会「点了没反应」（黑盒报告 D12 的现场就是这样）。
   * 这里在挂载、窗口 resize、以及每次切换之后都对一次真实状态。
   */
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const refresh = (): void => {
      void window.dex?.window
        .isMaximized()
        .then((result) => setMaximized(result.maximized))
        .catch(() => undefined)
    }
    refresh()
    window.addEventListener('resize', refresh)
    return () => window.removeEventListener('resize', refresh)
  }, [])
  const { preference, cycle } = useTheme()
  const back = useNavigationStore((state) => state.back)
  const forward = useNavigationStore((state) => state.forward)
  const canBack = useNavigationStore((state) => state.index > 0)
  const canForward = useNavigationStore((state) => state.index < state.entries.length - 1)
  const sessionWorkspaceId = useChatStore((state) => state.workspaceId)
  const workspacePath = useChatStore((state) => state.workspacePath)
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((item) => item.id === (sessionWorkspaceId ?? state.activeWorkspaceId)),
  )
  const loadHistory = useSessionStore((state) => state.load)

  const runMenuAction = (action: () => void): void => {
    action()
    setOpenMenu(null)
  }

  const path = workspacePath ?? workspace?.path ?? '选择一个工作区开始'

  return (
    <header className="titlebar" data-testid="titlebar">
      <div className="titlebar-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="titlebar-wordmark">Dex</span>
      </div>
      {/* 工作区信息并入头栏，替代原 WorkspaceHeader（D-32） */}
      <div className="titlebar-workspace" title={path}>
        <span className="titlebar-workspace-name">
          {workspace?.name ??
            (workspacePath === null ? '未选择工作区' : workspaceName(workspacePath))}
        </span>
        <span className="titlebar-workspace-path">{path}</span>
      </div>
      <div className="titlebar-utility-group">
        <div className="titlebar-navigation">
          <button
            type="button"
            disabled={!canBack}
            title="后退到上一个会话"
            onClick={() => {
              const entry = back()
              if (entry !== null)
                window.dispatchEvent(new CustomEvent('dex:navigate-session', { detail: entry }))
            }}
            aria-label="后退到上一个会话"
          >
            ←
          </button>
          <button
            type="button"
            disabled={!canForward}
            title="前进到下一个会话"
            onClick={() => {
              const entry = forward()
              if (entry !== null)
                window.dispatchEvent(new CustomEvent('dex:navigate-session', { detail: entry }))
            }}
            aria-label="前进到下一个会话"
          >
            →
          </button>
        </div>
        <nav className="titlebar-menus" aria-label="应用菜单">
          {[
            ['文件', [{ label: '新建对话', action: onNewChat }]],
            [
              '编辑',
              [
                { label: '复制', action: () => document.execCommand('copy') },
                {
                  label: '粘贴',
                  action: () =>
                    void navigator.clipboard
                      ?.readText()
                      .then((text) => document.execCommand('insertText', false, text)),
                },
                { label: '全选', action: () => document.execCommand('selectAll') },
              ],
            ],
            [
              '视图',
              [
                { label: '显示 / 隐藏会话栏', action: onToggleSidebar },
                { label: '显示 / 隐藏观测栏', action: onToggleObserver },
                { label: '重置布局', action: onResetLayout },
              ],
            ],
            [
              '帮助',
              [
                {
                  label: '键盘快捷键',
                  action: () => setShortcutsOpen(true),
                },
              ],
            ],
          ].map(([name, actions]) => {
            const menuName = name as string
            const menuActions = actions as { label: string; action: () => void }[]
            return (
              <div key={menuName} className="titlebar-menu">
                <button
                  type="button"
                  className="titlebar-menu-trigger"
                  onClick={() => setOpenMenu(openMenu === menuName ? null : menuName)}
                >
                  {menuName}
                </button>
                {openMenu === menuName ? (
                  <div className="titlebar-menu-popover">
                    {menuActions.length === 0 ? (
                      <span className="titlebar-menu-disabled">暂未提供操作</span>
                    ) : (
                      menuActions.map((item) => (
                        <button
                          type="button"
                          key={item.label}
                          onClick={() => runMenuAction(item.action)}
                        >
                          {item.label}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </nav>
      </div>
      <div className="titlebar-utility-group titlebar-utility-group-trailing">
        <div className="titlebar-actions">
          <button
            type="button"
            className="titlebar-action"
            title="刷新会话历史"
            aria-label="刷新会话历史"
            onClick={() => void loadHistory()}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            type="button"
            className="titlebar-action"
            title="显示 / 隐藏观测面板"
            aria-label={observerVisible ? '隐藏观测面板' : '显示观测面板'}
            aria-pressed={observerVisible}
            data-active={observerVisible}
            data-testid="toggle-observer"
            onClick={onToggleObserver}
          >
            <Icon name="graph" size={14} />
          </button>
        </div>
        <button
          type="button"
          className="titlebar-theme-toggle"
          onClick={cycle}
          title={`外观：${THEME_LABEL[preference]} — 点击切换（跟随系统 → 浅色 → 深色）`}
          aria-label={`切换外观，当前为${THEME_LABEL[preference]}`}
          data-testid="theme-toggle"
        >
          <Icon name={THEME_ICON[preference]} size={14} />
          <span className="titlebar-theme-label">{THEME_LABEL[preference]}</span>
        </button>
      </div>
      <div className="titlebar-window-actions">
        <button
          type="button"
          title="最小化"
          onClick={() => void window.dex?.window.minimize()}
          aria-label="最小化"
        >
          —
        </button>
        <button
          type="button"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          aria-pressed={maximized}
          data-testid="window-maximize"
          onClick={() => {
            void window.dex?.window
              .toggleMaximize()
              .then((result) => setMaximized(result.maximized === true))
              .catch(() => undefined)
          }}
        >
          {maximized ? '❐' : '□'}
        </button>
        <button
          type="button"
          className="titlebar-close"
          title="关闭"
          onClick={() => void window.dex?.window.close()}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
    </header>
  )
}
