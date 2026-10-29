import { createDemoGraphSnapshot, playDemoLoop } from '@dexagent/fake-dsh'
import { type AppError, DEFAULT_WS_PORT } from '@dexagent/shared'
import { type WebSocket, WebSocketServer } from 'ws'
import type { EventHub } from './event-hub'

export interface EventServerOptions {
  readonly demo?: boolean
  /**
   * 事件通道绑定失败时的上报口。
   *
   * MUST NOT 当成可忽略的噪声：4319 是 renderer 唯一的出站口，一旦被**别的 Dex 实例**占着，
   * 新起的 renderer 仍会连上那个进程的 hub，静默继承它的会话、trace、宿主状态。
   * 症状是「界面状态一塌糊涂」而不是「启动失败」——比直接报错难查得多（U-14 / U-15）。
   */
  readonly onBindError?: (error: AppError) => void
}

/** 把 socket 绑定错误翻译成跨边界统一的 `{ code, message, retryable }`。 */
export function describeEventServerError(error: Error, port: number): AppError {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    return {
      code: 'EVENT_SERVER_PORT_IN_USE',
      message: `事件通道端口 127.0.0.1:${String(port)} 已被占用：另一个 Dex 实例还在运行。`,
      retryable: true,
    }
  }
  return {
    code: 'EVENT_SERVER_FAILED',
    message: `事件通道绑定失败：${error.message}`,
    retryable: true,
  }
}

export function startDemoEvents(hub: EventHub, enabled: boolean): () => void {
  if (!enabled) return () => {}
  hub.publish(createDemoGraphSnapshot())
  return playDemoLoop((message) => hub.publish(message))
}

/**
 * renderer 唯一的 WS 入口（127.0.0.1:4319）。
 * 正常模式只转发真实 dsh 数据；演示模式由显式开关开启，且全局只启动一套。
 */
export function startEventServer(
  hub: EventHub,
  port: number = DEFAULT_WS_PORT,
  options: EventServerOptions = {},
): () => void {
  const server = new WebSocketServer({ host: '127.0.0.1', port })
  const stopDemo = startDemoEvents(hub, options.demo === true)

  server.on('connection', (socket: WebSocket) => {
    hub.addClient(socket)
  })

  server.on('error', (error: Error) => {
    const failure = describeEventServerError(error, port)
    console.error(`[event-server] ${failure.code}: ${failure.message}`)
    options.onBindError?.(failure)
  })

  return () => {
    stopDemo()
    server.close()
  }
}
