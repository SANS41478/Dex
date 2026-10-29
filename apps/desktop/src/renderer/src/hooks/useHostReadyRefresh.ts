import { useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useHostStore } from '../stores/hostStore'
import { useModelStore } from '../stores/modelStore'
import { useSessionStore } from '../stores/sessionStore'

/**
 * 宿主就绪后修复冷启动期失败的首拉。
 *
 * `host.start()` 是 fire-and-forget，renderer 一挂载就会要模型目录与会话历史，首拉可能落在
 * dsh webServer bind（本机实测冷启动 23.2s）之前。main 侧有连接层退避重试兜底，机器更慢时
 * 仍可能失败；而 store 会把 `error` latch 住不再自动刷新——这里在收到 `host.status = ready`
 * 后**只补确实失败过的那两项**，不去覆盖已经拿到的数据。
 */
export function useHostReadyRefresh(): void {
  const hostReady = useHostStore((state) => state.phase === 'ready')
  useEffect(() => {
    if (!hostReady) return
    const models = useModelStore.getState()
    if (models.loadState === 'error') {
      void models.load(useChatStore.getState().activeSessionId ?? undefined)
    }
    if (useSessionStore.getState().error !== null) {
      void useSessionStore.getState().load()
    }
  }, [hostReady])
}
