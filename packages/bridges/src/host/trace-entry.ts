/**
 * dsh 宿主入口插件（M2-03 侧信道模式）：注册 trace 投影 + `/dex-trace` 升级路由。
 *
 * 数据流：`ctx.sessionProjections.onChanged`（投影变更）→ `trace-bridge` diff →
 * 六类 `trace.*` 协议消息广播；默认连接先收到全量回放（按会话），
 * `?live=1` 连接只接收后续实时增量。
 *
 * 该模块被打包为自包含 ESM（vite lib 模式），由 dex profile 的 patch 以 `file://` 直载；
 * 必须**只有默认导出**（cordis loader 取 `exports.default`）。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { TraceMessage } from '@dexagent/shared'
import { WebSocketServer } from 'ws'
import { adaptEntries } from '../dsh/adapt'
import type { SessionLike, SessionProjectionsLike, SessionsServiceLike } from '../dsh/session'
import { createToolOwnerResolver } from '../plugins/tool-owners'
import { createTraceBridge } from '../plugins/trace-bridge'
import { type TraceProjectionState, traceProjectionStateSchema } from '../plugins/trace-fold'
import { createTraceProjection, TRACE_PROJECTION_KEY } from '../plugins/trace-projection'
import type { DexWebServer } from './entry'

export const DEX_TRACE_HOST_NAME = 'dex-trace-bridge'
export const DEX_TRACE_ROUTE = '/dex-trace'

const WS_OPEN = 1

export interface DexTraceContext {
  /** 官方 Loader 的原始条目（`pluginId` 反查用；经 `adaptEntries` 收口）。 */
  readonly loader: { entries(): Iterable<unknown> }
  readonly webServer: DexWebServer
  readonly sessionProjections: SessionProjectionsLike
  readonly sessions: SessionsServiceLike
  /** cordis 清理钩子（fiber 卸载时注销投影/变更流/路由并关闭 ws server）；缺省如实降级。 */
  readonly effect?: (execute: () => () => unknown, label?: string) => unknown
}

export interface DexTraceHost {
  readonly name: string
  readonly inject: readonly string[]
  readonly apply: (ctx: DexTraceContext) => void
}

export interface DexTraceHostOptions {
  readonly routePath?: string
  /** 诊断日志出口（默认 stderr；stdout 归 SDK JSON-RPC 独占）。 */
  readonly log?: (line: string) => void
}

function parseState(value: unknown): TraceProjectionState | null {
  const parsed = traceProjectionStateSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function createDexTraceHost(options: DexTraceHostOptions = {}): DexTraceHost {
  const routePath = options.routePath ?? DEX_TRACE_ROUTE
  // stdout 归 SDK JSON-RPC 独占，诊断只走 stderr。
  const log =
    options.log ??
    ((message: string): void => {
      process.stderr.write(`[dex-trace-bridge] ${message}\n`)
    })

  return {
    name: DEX_TRACE_HOST_NAME,
    inject: ['loader', 'webServer', 'sessionProjections', 'sessions'],
    apply(ctx) {
      const server = new WebSocketServer({ noServer: true })
      const unregisterProjection = ctx.sessionProjections.register(createTraceProjection())

      const resolvePluginId = createToolOwnerResolver(() => adaptEntries(ctx.loader.entries()))
      const bridge = createTraceBridge({
        resolvePluginId,
        now: Date.now,
        sink: (message: TraceMessage) => {
          const payload = JSON.stringify(message)
          for (const client of server.clients) {
            if (client.readyState === WS_OPEN) client.send(payload)
          }
        },
      })

      // 会话对象只在 onChanged 回调与 list() 中出现；记住它们以便新连接回放 stateOf。
      const knownSessions = new Map<string, SessionLike>()
      for (const session of ctx.sessions.list?.() ?? []) knownSessions.set(session.id, session)

      const unsubscribe = ctx.sessionProjections.onChanged((session, key, value) => {
        if (key !== TRACE_PROJECTION_KEY) return
        knownSessions.set(session.id, session)
        const state = parseState(value)
        if (state !== null) bridge.feed(state)
      })

      const unregister = ctx.webServer.registerUpgrade({
        path: routePath,
        handler(req: IncomingMessage, socket: Duplex, head: Buffer) {
          log(`upgrade ${req.url ?? ''}`)
          server.handleUpgrade(req, socket, head, (ws) => {
            log('client connected')
            ws.on('error', (error) => {
              log(`client error ${error.message}`)
            })
            const liveOnly =
              new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('live') === '1'
            // renderer 主链使用 live=1，避免启动时把历史会话自动灌进实时 DAG。
            // 其它诊断/恢复连接仍保留显式回放能力。
            if (liveOnly) return
            // 新连接先回放（只发该连接；后续增量走广播，渲染端 fold 幂等）。
            let count = 0
            for (const session of knownSessions.values()) {
              const state = parseState(
                ctx.sessionProjections.stateOf(session, TRACE_PROJECTION_KEY),
              )
              if (state === null) continue
              for (const message of bridge.messagesFor(state)) {
                ws.send(JSON.stringify(message))
                count += 1
              }
            }
            log(`replay messages=${count} sessions=${knownSessions.size}`)
          })
        },
      })
      // fiber 卸载：先断变更流与路由，再关 server，避免 callback 触碰已死的 context。
      ctx.effect?.(
        () => () => {
          unregister()
          unsubscribe()
          unregisterProjection()
          server.close()
        },
        'dex-trace-bridge:dispose',
      )
      log(`route registered ${routePath}`)
    },
  }
}

const host = createDexTraceHost()
export default host
