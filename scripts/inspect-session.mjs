/**
 * 会话执行流检查器：从正在运行的 dsh 宿主（`/dex-control`）拉取某个会话的
 * 折叠执行流，按 Turn/Step/ToolCall 打印，**含工具失败的原始输出**。
 *
 * 用途：界面只能看到模型复述过的人话（「权限错误」之类），排查要看原始报错；
 * 这个脚本直接问产品自己的回放接口，比翻 zstd 会话日志快。
 *
 * 用法：
 *   node scripts/inspect-session.mjs                     # 最近一次会话
 *   node scripts/inspect-session.mjs dex-1790241781696-1 # 指定会话
 *   DEX_CONTROL_PORT=4320 node scripts/inspect-session.mjs
 *
 * 前置：Dex（`pnpm dev`）与 dsh 宿主正在运行。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const repoRoot = process.cwd()
const requireFromBridges = createRequire(join(repoRoot, 'packages', 'bridges', 'package.json'))
const { WebSocket } = requireFromBridges('ws')

const port = process.env.DEX_CONTROL_PORT ?? '4320'
const url = `ws://127.0.0.1:${port}/dex-control`

function control(method, params = {}) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      fail(new Error(`控制通道无响应（${url}，宿主没在跑？）`))
    }, 20_000)
    socket.on('open', () =>
      socket.send(JSON.stringify({ requestId: `inspect-${Date.now()}`, method, ...params })),
    )
    socket.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    socket.on('message', (data) => {
      clearTimeout(timer)
      socket.close()
      done(JSON.parse(String(data)))
    })
  })
}

async function resolveSessionId() {
  const explicit = process.argv[2]
  if (explicit !== undefined && explicit !== '') return explicit
  const listed = await control('sessions/list', {})
  if (listed.ok !== true) throw new Error(`sessions/list 失败：${JSON.stringify(listed.error)}`)
  const newest = [...(listed.result.sessions ?? [])].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  )[0]
  if (newest === undefined) throw new Error('没有可读的会话')
  return newest.sessionId
}

const sessionId = await resolveSessionId()
const response = await control('sessions/replay', { sessionId })

if (response.ok !== true) {
  console.error('失败：', JSON.stringify(response.error))
  process.exit(1)
}

const state = response.result.traceState ?? response.result
console.log(`会话：${String(state.sessionId ?? sessionId)}`)
console.log(`策略变更：${JSON.stringify(state.policyChanges ?? [])}`)
console.log(`审批：${JSON.stringify(state.approvals ?? [])}`)
console.log('')

for (const turn of state.turns ?? []) {
  console.log(
    `— Turn ${String(turn.id)} [${String(turn.status)}] 提问：${String(turn.userMessage)}`,
  )
  if (turn.assistantMessage !== undefined) {
    console.log(`  助手：${String(turn.assistantMessage).slice(0, 500)}`)
  }
  for (const step of turn.steps ?? []) {
    console.log(
      `  · Step ${String(step.id)} [${String(step.status)}] ${String(step.llmReasoning).slice(0, 200)}`,
    )
    for (const call of step.toolCalls ?? []) {
      console.log(
        `    → ${String(call.toolName)} [${String(call.status)}] ${String(call.durationMs ?? '?')}ms`,
      )
      console.log(`      input: ${JSON.stringify(call.input).slice(0, 500)}`)
      if (call.output !== undefined) {
        console.log(`      output: ${JSON.stringify(call.output).slice(0, 1200)}`)
      }
    }
  }
  console.log('')
}
