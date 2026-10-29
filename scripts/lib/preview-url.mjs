/**
 * 预览地址解析：优先 env 覆盖，否则探测 127.0.0.1 → ::1（Vite 可能只绑 IPv6）。
 */
import { createConnection } from 'node:net'

function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

export async function resolvePreviewUrl(override) {
  if (override !== undefined && override !== '') return override
  if (await canConnect('127.0.0.1', 5173)) return 'http://127.0.0.1:5173'
  if (await canConnect('::1', 5173)) return 'http://[::1]:5173'
  return 'http://localhost:5173'
}
