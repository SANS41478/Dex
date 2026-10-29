import { type Message, parseEnvelope } from '@dexagent/shared'
import { WebSocket } from 'ws'

export type BridgeChannelState = 'connected' | 'closed' | 'error'

/** 窄化的 WS 客户端（真实 `ws` 连接与测试替身都满足它）。 */
export interface BridgeSocket {
  readonly readyState: number
  close(): unknown
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface BridgeChannelOptions {
  readonly url: string
  /** 只转发接受的消息类型（图谱 / trace 各一个通道实例）。 */
  readonly accept: (message: Message) => boolean
  readonly onMessage: (message: Message) => void
  readonly onState?: (state: BridgeChannelState, detail?: string | undefined) => void
  readonly log?: (line: string) => void
  readonly reconnectDelaysMs?: readonly number[]
  readonly socketFactory?: (url: string) => BridgeSocket
}

export interface BridgeChannel {
  readonly stop: () => void
  readonly isConnected: () => boolean
}

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000] as const
const WS_OPEN = 1

/** 连 dsh 侧侧信道路由（`/dex-graph`、`/dex-trace`）：解析信封 → 过滤 → 转发；断线按退避重连。 */
export function createBridgeChannel(options: BridgeChannelOptions): BridgeChannel {
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
  const factory = options.socketFactory ?? ((url: string) => new WebSocket(url))

  let socket: BridgeSocket | null = null
  let stopped = false
  let attempt = 0
  let timer: NodeJS.Timeout | null = null

  const connect = (): void => {
    if (stopped) return
    const ws = factory(options.url)
    socket = ws

    ws.on('open', () => {
      attempt = 0
      options.onState?.('connected')
    })
    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : String(data)
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return
      }
      const parsed = parseEnvelope(raw)
      if (!parsed.ok) return
      if (options.accept(parsed.message)) options.onMessage(parsed.message)
    })
    ws.on('error', (error) => {
      options.onState?.('error', error.message)
    })
    ws.on('close', () => {
      socket = null
      if (stopped) return
      options.onState?.('closed')
      const index = Math.min(attempt, delays.length - 1)
      attempt += 1
      const delay = delays[index] ?? 5000
      options.log?.(`[bridge-channel] ${delay}ms 后重连`)
      timer = setTimeout(connect, delay)
    })
  }

  connect()

  return {
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      socket?.close()
      socket = null
    },
    isConnected: () => socket !== null && socket.readyState === WS_OPEN,
  }
}
