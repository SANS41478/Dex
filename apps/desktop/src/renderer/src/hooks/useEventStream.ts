import {
  DEFAULT_WS_PORT,
  isGraphMessage,
  isHostMessage,
  isSessionMessage,
  isTraceMessage,
  parseEnvelope,
} from '@dexagent/shared'
import { useEffect } from 'react'
import ReconnectingWebSocket from 'reconnecting-websocket'
import { useChatStore } from '../stores/chatStore'
import { useConnectionStore } from '../stores/connectionStore'
import { useGraphStore } from '../stores/graphStore'
import { useHostStore } from '../stores/hostStore'
import { useSessionStatusStore } from '../stores/sessionStatusStore'
import { useSessionUnreadStore } from '../stores/sessionUnreadStore'
import { useTraceStore } from '../stores/traceStore'

const defaultUrl = `ws://127.0.0.1:${DEFAULT_WS_PORT}`

function handleMessage(raw: unknown): void {
  if (typeof raw !== 'string') return

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  const parsed = parseEnvelope(data)
  if (!parsed.ok) {
    console.warn('[protocol] 非法消息已丢弃:', parsed.error.issues[0]?.message)
    return
  }

  useConnectionStore.getState().markReceived()
  if (isTraceMessage(parsed.message)) {
    useTraceStore.getState().dispatch(parsed.message)
  } else if (isGraphMessage(parsed.message)) {
    useGraphStore.getState().dispatch(parsed.message)
  } else if (isSessionMessage(parsed.message)) {
    const statusStore = useSessionStatusStore.getState()
    // 先取跃迁前状态（缺键 = 未知），apply 后同点喂未读 reducer（C-5 completionUnread）。
    const previous = statusStore.statuses[parsed.message.payload.sessionId]
    statusStore.apply(parsed.message.payload)
    useSessionUnreadStore
      .getState()
      .observe(
        parsed.message.payload.sessionId,
        previous,
        parsed.message.payload.status,
        useChatStore.getState().activeSessionId,
      )
  } else if (isHostMessage(parsed.message)) {
    useHostStore.getState().setStatus(parsed.message.payload)
  }
}

export function useEventStream(url: string = defaultUrl): void {
  useEffect(() => {
    const socket = new ReconnectingWebSocket(url)
    socket.addEventListener('open', () => {
      useConnectionStore.getState().setStatus('open')
    })
    socket.addEventListener('close', () => {
      useConnectionStore.getState().setStatus('closed')
    })
    socket.addEventListener('message', (event) => {
      handleMessage(event.data)
    })
    return () => {
      socket.close()
    }
  }, [url])
}
