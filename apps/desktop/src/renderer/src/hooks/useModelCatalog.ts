import { useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useModelStore } from '../stores/modelStore'
import { useTraceStore } from '../stores/traceStore'

/**
 * 模型目录首拉与按会话重拉（C-3 收敛迁移而来）。
 *
 * 原先这段 effect 挂在 SessionPanel 的 ModelControl 上——但 ModelControl 的唯一挂载点
 * 已移入设置抽屉（未打开时不挂载），抽屉里的 effect 承担不了启动首拉与会话切换重拉。
 * 目录又是 Composer 模型下拉的数据源，所以拉取时机上移到总是挂载的 App 层。
 *
 * sessionId 口径与迁移前一致：活跃会话优先，无活跃会话但有 trace 时退回 trace 会话。
 */
export function useModelCatalog(): void {
  const load = useModelStore((state) => state.load)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const turns = useTraceStore((state) => state.turns)
  const traceSessionId = useMemo(() => {
    const latest = turns.at(-1)?.id
    if (latest === undefined) return undefined
    const marker = latest.lastIndexOf(':t')
    return marker > 0 ? latest.slice(0, marker) : undefined
  }, [turns])
  const sessionId = activeSessionId ?? traceSessionId

  useEffect(() => {
    void load(sessionId)
  }, [load, sessionId])
}
