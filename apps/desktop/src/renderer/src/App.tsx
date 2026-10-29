import { useCallback, useEffect, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { AppSidebar } from './components/layout/AppSidebar'
import { TitleBar } from './components/layout/TitleBar'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { matchShortcut } from './core/shortcuts'
import { useEventStream } from './hooks/useEventStream'
import { useHostReadyRefresh } from './hooks/useHostReadyRefresh'
import { useModelCatalog } from './hooks/useModelCatalog'
import { useRestoreActiveSession } from './hooks/useRestoreActiveSession'
import { ChatPanel } from './panels/ChatPanel'
import { ObserverPanel } from './panels/ObserverPanel'
import { useChatStore } from './stores/chatStore'
import { useObserverStore } from './stores/observerStore'
import { useSessionStore } from './stores/sessionStore'
import { useTraceStore } from './stores/traceStore'
import { addWorkspaceAndCreateSession } from './stores/workspaceActions'
import { useWorkspaceStore } from './stores/workspaceStore'

export function App() {
  useEventStream()
  useHostReadyRefresh()
  useModelCatalog()
  useRestoreActiveSession()
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const observerVisible = useObserverStore((state) => state.visible)
  const toggleObserver = useObserverStore((state) => state.toggle)
  const newChat = useCallback(() => {
    void useChatStore
      .getState()
      .newSession()
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'NO_WORKSPACE') {
          return addWorkspaceAndCreateSession()
        }
        return undefined
      })
      .catch(() => undefined)
  }, [])

  /*
   * 全局快捷键（`core/shortcuts.ts` 是唯一的事实源，帮助面板展示的就是这一份）。
   * 原实现只在「帮助」菜单里用 `window.alert` 写了一句「Ctrl/Cmd+K 搜索」，
   * 但那条快捷键**从未实现**——用户照着按只会得到「没反应」（黑盒报告 D11）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = matchShortcut(event)
      if (action === null) return
      event.preventDefault()
      if (action === 'new-chat') {
        newChat()
        return
      }
      // 侧栏可能正被隐藏，先显示再聚焦；等一帧是因为 Panel 重新挂载需要一次渲染。
      setSidebarVisible(true)
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('[data-testid="sidebar-search"]')?.focus()
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [newChat])

  useEffect(() => {
    const onNavigate = (event: Event): void => {
      const sessionId = (event as CustomEvent<string>).detail
      const workspaceId = useWorkspaceStore.getState().sessionWorkspace[sessionId]
      const workspace = useWorkspaceStore
        .getState()
        .workspaces.find((item) => item.id === workspaceId)
      if (workspace === undefined) return
      void useChatStore
        .getState()
        .activate(sessionId, workspace.path)
        .then(() => useSessionStore.getState().replay(sessionId, true))
        .catch(() => undefined)
    }
    window.addEventListener('dex:navigate-session', onNavigate)
    return () => window.removeEventListener('dex:navigate-session', onNavigate)
  }, [])

  // 工作区宽度持久化：只记录用户拖拽产生的布局。
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'dex-coding-shell',
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  })

  /*
   * DEV 诊断钩子（与 GraphPanel 的 `__dexGraphDebug` 同约定）：让诊断脚本能驱动**这一个**
   * store 实例。浏览器预览里 Trace 没有真源（`window.dex` 只在 Electron 存在），
   * 靠它注入真实形态的事件来验证详情面板与时间线的渲染/交互。
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__dexTraceDebug = {
      dispatch: (message) => {
        useTraceStore.getState().dispatch(message)
      },
      state: () => {
        const state = useTraceStore.getState()
        return {
          turns: state.turns,
          viewMode: state.viewMode,
          policyChanges: state.policyChanges,
          approvals: state.approvals,
        }
      },
      clear: () => {
        useTraceStore.getState().clear()
      },
    }
    return () => {
      delete window.__dexTraceDebug
    }
  }, [])

  return (
    <div className="app-window">
      <TitleBar
        onNewChat={newChat}
        onToggleSidebar={() => setSidebarVisible((value) => !value)}
        onToggleObserver={toggleObserver}
        onResetLayout={() => {
          // 库实际写入的键带 `react-resizable-panels:` 前缀（见 useDefaultLayout 实现）；
          // 早先只删裸 id，按钮一直是无效的。
          localStorage.removeItem('react-resizable-panels:dex-coding-shell')
          localStorage.removeItem('react-resizable-panels:dex-observer-split')
          window.location.reload()
        }}
        observerVisible={observerVisible}
      />
      <Group
        orientation="horizontal"
        className="shell"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {sidebarVisible ? (
          <>
            {/*
              尺寸用**像素**而非百分比：下限不随窗口宽度浮动，「拖到那个范围就停住」是可预期的。
              刻意**不用 collapsible/collapsedSize**——库的语义是「小于 minSize 就瞬间吸附到
              collapsedSize」，那正是「缩到一定范围突然变成一条细缝」的来源。完全隐藏改由
              顶栏的显隐开关（不渲染 Panel）负责，不靠吸附。
            */}
            <Panel id="session" defaultSize="24" minSize={200}>
              <AppSidebar />
            </Panel>
            <Separator className="resize-handle" />
          </>
        ) : null}
        <Panel id="chat" defaultSize={observerVisible ? '48' : '76'} minSize={360}>
          <main className="workspace-shell">
            <ChatPanel />
          </main>
        </Panel>
        {observerVisible ? (
          <>
            <Separator className="resize-handle" />
            <Panel id="observer" defaultSize="28" minSize={280}>
              <ObserverPanel />
            </Panel>
          </>
        ) : null}
      </Group>
      <SettingsDialog />
    </div>
  )
}
