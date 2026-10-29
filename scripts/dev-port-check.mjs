/**
 * FIX-017 / D36：`pnpm dev` 的端口冲突前置诊断。
 *
 * 现场（黑盒报告 D20）：重复 `pnpm dev` 时失败信息只来自 electron-vite
 * （`Port 5173 is already in use` → `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`），
 * 看不出「是谁占着、怎么结束」。本脚本在 dev 链路最前面做一次**只读**探测：
 *
 * - 端口空闲：静默通过，行为与从前完全一致；
 * - 端口被占：打印占用 PID 与处理办法，然后**照常退出 0**，把失败判定留给
 *   electron-vite 自己（不越权替它失败，也绝不 kill 任何进程）。
 *
 * 用法：node scripts/dev-port-check.mjs
 */

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const PORT = 5173

/** 试着绑定一个地址；EADDRINUSE 即「被占」。 */
function probe(host) {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    server.once('error', (error) => {
      server.close()
      settle(error.code === 'EADDRINUSE')
    })
    server.once('listening', () => {
      server.close(() => settle(false))
    })
    server.listen(PORT, host)
  })
}

/** 只读地找出占用者 PID；取不到就返回 null（提示退化为通用方法）。 */
function findOwnerPid() {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes(`:${String(PORT)}`) || !line.includes('LISTENING')) continue
        const pid = line.trim().split(/\s+/).at(-1)
        if (pid !== undefined && pid !== '0') return pid
      }
      return null
    }
    const output = execFileSync('lsof', ['-ti', `tcp:${String(PORT)}`], { encoding: 'utf8' })
    const pid = output.trim().split(/\r?\n/)[0]
    return pid === undefined || pid === '' ? null : pid
  } catch {
    return null
  }
}

function hint(pid) {
  const lines = [
    `[dev] 端口 ${String(PORT)} 已被占用——electron-vite 的 renderer 配置了 strictPort，继续启动会失败。`,
  ]
  if (pid !== null) {
    lines.push(`      占用进程 PID：${pid}（多半是另一个 pnpm dev / Electron 实例）`)
    lines.push(
      process.platform === 'win32'
        ? `      结束它：taskkill /PID ${pid} /F`
        : `      结束它：kill ${pid}`,
    )
  } else {
    lines.push('      未能取到占用进程 PID，可手动查看：')
    lines.push(
      process.platform === 'win32'
        ? `      netstat -ano | findstr :${String(PORT)}`
        : `      lsof -i :${String(PORT)}`,
    )
  }
  lines.push('      以上仅为前置诊断；随后仍由 electron-vite 自行判定启动结果。')
  return lines.join('\n')
}

const [v4, v6] = await Promise.all([probe('127.0.0.1'), probe('::1')])
if (v4 || v6) {
  process.stderr.write(`${hint(findOwnerPid())}\n`)
}
process.exit(0)
