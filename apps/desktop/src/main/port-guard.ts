import { createServer } from 'node:net'

export interface PortProbeResult {
  readonly free: boolean
  readonly code?: string
  readonly message?: string
}

/**
 * spawn 前预探测端口（U-15 · 与 4319 的 fail-loud 模式同构）。
 *
 * 4320 被别的 dsh 宿主占用时，本进程的 `dex-webserver` 行不会激活（dsh 侧只是
 * 「条目不激活」），但 main 原先仍会把 controlUrl / traceUrl 指向 4320——
 * 即指向**别人的宿主**，静默继承外来会话与 trace 状态。
 * 把故障面前移到 spawn 之前：绑不上就显式失败，绝不静默降级。
 *
 * 残余 TOCTOU 窗口（探测释放到宿主真正绑定之间被抢）内，宿主 webserver 行会
 * `EADDRINUSE` → cordis `provide()` throw → 插件树 fail-loud，宿主状态报 error，
 * 同样不是静默——故无需握手确认（nonce 方案存档推后）。
 */
export function probePortFree(input: {
  readonly port: number
  readonly host?: string
  readonly timeoutMs?: number
}): Promise<PortProbeResult> {
  const host = input.host ?? '127.0.0.1'
  const timeoutMs = input.timeoutMs ?? 3000
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const settle = (result: PortProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    server.once('error', (error: NodeJS.ErrnoException) => {
      server.close()
      if (error.code === 'EADDRINUSE') {
        settle({
          free: false,
          code: 'EADDRINUSE',
          message: `端口 ${host}:${String(input.port)} 已被其他进程占用`,
        })
        return
      }
      settle({ free: false, code: error.code ?? 'EACCES', message: error.message })
    })
    server.once('listening', () => {
      server.close(() => settle({ free: true }))
    })
    const timer = setTimeout(() => {
      server.close()
      settle({ free: false, code: 'ETIMEDOUT', message: `端口探测超时（${String(timeoutMs)}ms）` })
    }, timeoutMs)
    timer.unref()
    server.listen(input.port, host)
  })
}
