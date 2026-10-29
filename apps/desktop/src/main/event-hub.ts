import {
  applyGraphMessage,
  applyTraceMessage,
  encodeMessage,
  type GraphState,
  type HostMessage,
  initialGraphState,
  initialTraceState,
  isGraphMessage,
  isHostMessage,
  isSessionMessage,
  isTraceMessage,
  type Message,
  makeMessage,
  type SessionStatus,
  traceStateToMessages,
} from '@dexagent/shared'

/** 窄化的 WS 客户端接触面：真实 `ws` 连接与测试替身都满足它。 */
export interface HubClient {
  readonly readyState: number
  send(data: string): unknown
  on(event: 'close', listener: () => void): unknown
}

const WS_OPEN = 1
export interface EventHub {
  readonly addClient: (client: HubClient) => void
  /** 只广播，不改状态（演示/事件流类消息）。 */
  readonly broadcast: (message: Message) => void
  /** 广播并折叠进状态（图谱与宿主状态），新客户端接入时按当前状态补发。 */
  readonly publish: (message: Message) => void
  /** 是否已有某类状态（用于演示数据与真实数据的切换判断）。 */
  readonly hasCached: (type: Message['type']) => boolean
  readonly clientCount: () => number
}

/** renderer 的唯一出站口：所有数据源（dsh 宿主 / 演示流）都经它广播。 */
export function createEventHub(): EventHub {
  const clients = new Set<HubClient>()
  let graphState: GraphState = initialGraphState
  let graphReceived = false
  let hostStatus: HostMessage | null = null
  let traceState = initialTraceState
  let traceReceived = false
  // 会话级运行状态基线：按 sessionId 只留最新一条。
  // 后连 / 重连的 renderer 据此拿到**当前**状态，不必等下一次状态变化——
  // 这正是「漏掉一条终态通知就永久卡在运行中」的解药。
  const sessionStatuses = new Map<string, SessionStatus>()

  const send = (client: HubClient, message: Message): void => {
    if (client.readyState === WS_OPEN) client.send(encodeMessage(message))
  }

  return {
    addClient(client) {
      clients.add(client)
      client.on('close', () => {
        clients.delete(client)
      })
      if (hostStatus !== null) send(client, hostStatus)
      if (graphReceived) {
        send(
          client,
          makeMessage('graph.snapshot', { nodes: graphState.nodes, links: graphState.links }),
        )
      }
      // trace 回放：从 canonical 状态派生完整、有序消息，避免部分缓存造成状态缺口。
      for (const message of traceStateToMessages(traceState)) send(client, message)
      // 会话状态基线：每个会话一条最新值。
      for (const status of sessionStatuses.values()) {
        send(client, makeMessage('session.status', status))
      }
    },
    broadcast(message) {
      for (const client of clients) send(client, message)
    },
    publish(message) {
      if (isGraphMessage(message)) {
        graphState = applyGraphMessage(graphState, message)
        graphReceived = true
      } else if (isHostMessage(message)) {
        hostStatus = message
      } else if (isSessionMessage(message)) {
        sessionStatuses.set(message.payload.sessionId, message.payload)
      } else if (isTraceMessage(message)) {
        traceReceived = true
        traceState = applyTraceMessage(traceState, message)
      }
      for (const client of clients) send(client, message)
    },
    hasCached(type) {
      if (type === 'graph.snapshot') return graphReceived
      if (type === 'host.status') return hostStatus !== null
      if (type === 'session.status') return sessionStatuses.size > 0
      if (type.startsWith('trace.')) return traceReceived
      return false
    },
    clientCount: () => clients.size,
  }
}
