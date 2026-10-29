/**
 * dsh 宿主入口插件（M1-04b/M1-05）：图谱经官方 webserver 的升级路由推给 Electron main。
 *
 * 该模块被打包为自包含 ESM（vite lib 模式），由 dex profile 的 patch 以 `file://` 直载；
 * 必须**只有默认导出**（cordis loader 取 `exports.default`）。
 * 传输层职责：路由 + 连接快照 + 广播；增量逻辑在 `plugins/graph-bridge.ts`。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { adaptEntries } from '../dsh/adapt'
import type { DshEventMap, DshEventName, DshEventOptions } from '../dsh/contract'
import { createGraphBridge } from '../plugins/graph-bridge'

export const DEX_GRAPH_HOST_NAME = 'dex-graph-bridge'
export const DEX_GRAPH_ROUTE = '/dex-graph'

const WS_OPEN = 1

/** 窄化的官方 webserver 接触面（`ctx.webServer` 的最小投影）。 */
export interface DexWebServer {
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  }): () => void
}

export interface DexHostContext {
  /** 官方 Loader 的原始条目（经 `adaptEntries` 收口为契约类型）。 */
  readonly loader: { entries(): Iterable<unknown> }
  readonly webServer: DexWebServer
  /** cordis 事件订阅（桥接插件必须用 `{ global: true }` 才收到兄弟条目事件）。 */
  on<K extends DshEventName>(
    event: K,
    listener: DshEventMap[K],
    options?: DshEventOptions,
  ): () => boolean
  /**
   * cordis 清理钩子。插件 fiber 卸载（宿主重载 / 进程退出）时必须取消防抖窗口、
   * 注销升级路由并关闭 ws server——否则定时器/升级回调会在失效 context 上读
   * loader 抛错打死宿主（2026-10-08 实测）。缺省时如实降级为「不主动清理」。
   */
  readonly effect?: (execute: () => () => unknown, label?: string) => unknown
}

export interface DexGraphHost {
  readonly name: string
  readonly inject: readonly string[]
  readonly apply: (ctx: DexHostContext) => void
}

export interface DexGraphHostOptions {
  readonly routePath?: string
  readonly debounceMs?: number
}

export function createDexGraphHost(options: DexGraphHostOptions = {}): DexGraphHost {
  const routePath = options.routePath ?? DEX_GRAPH_ROUTE
  // stdout 归 SDK JSON-RPC 独占，诊断只走 stderr。
  const log = (message: string, always = true): void => {
    if (always) process.stderr.write(`[dex-graph-bridge] ${message}\n`)
  }

  return {
    name: DEX_GRAPH_HOST_NAME,
    inject: ['loader', 'webServer'],
    apply(ctx) {
      const server = new WebSocketServer({ noServer: true })

      const bridge = createGraphBridge({
        readEntries: () => adaptEntries(ctx.loader.entries()),
        subscribe: (requestFlush) => {
          ctx.on('loader/entry-init', () => requestFlush(), { global: true })
          ctx.on('internal/plugin', () => requestFlush(), { global: true })
          ctx.on('internal/status', () => requestFlush(), { global: true })
        },
        sink: (message) => {
          const payload = JSON.stringify(message)
          for (const client of server.clients) {
            if (client.readyState === WS_OPEN) client.send(payload)
          }
        },
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      })
      bridge.apply()

      const unregister = ctx.webServer.registerUpgrade({
        path: routePath,
        handler(req, socket, head) {
          log(`upgrade ${req.url ?? ''}`)
          server.handleUpgrade(req, socket, head, (ws) => {
            log('client connected')
            ws.on('close', (code, reason) => {
              log(`client closed code=${String(code)} reason=${String(reason)}`)
            })
            ws.on('error', (error) => {
              log(`client error ${error.message}`)
            })
            const payload = JSON.stringify(bridge.snapshot())
            log(`sending snapshot bytes=${payload.length}`)
            ws.send(payload, (error?: Error | null) => {
              log(
                error === undefined || error === null
                  ? 'snapshot sent'
                  : `send error ${error.message}`,
              )
            })
          })
        },
      })
      // fiber 卸载顺序无所谓：dispose 先让桥接失效（防抖窗口 + 读取兜底），
      // 再注销路由、关闭 server，保证没有回调还能碰到已死的 context。
      ctx.effect?.(
        () => () => {
          bridge.dispose()
          unregister()
          server.close()
        },
        'dex-graph-bridge:dispose',
      )
      log(`route registered ${routePath}`, process.env.DEX_GRAPH_DEBUG === '1')
    },
  }
}

const host = createDexGraphHost()
export default host
