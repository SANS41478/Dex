import type { StepRecord, ToolCallRecord } from './trace'

/**
 * 「这一步到底干了什么」的人话派生（纯函数，执行流 / 时间线 / 详情面板共用）。
 *
 * 为什么需要它：DAG 节点与时间线行过去显示的是 `step.llmReasoning` 的前 44 个字符——
 * 那是模型自己的话（现在还会与思考混在一起），既不是动作，也不稳定。
 * 用户的实际问题「这一行是什么」应该由**工具调用**回答：调用了什么、对谁做的。
 */

/** 工具名 → 人话动作短语。未收录的工具回退为「下划线转空格」的原名。 */
export const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  read: '读取文件',
  read_image: '查看图片',
  write: '写入文件',
  edit: '编辑文件',
  str_replace_editor: '编辑文件',
  glob: '查找文件',
  grep: '搜索内容',
  pwsh: '执行命令',
  bash: '执行命令',
  run_code: '运行代码',
  web_search: '联网检索',
  web_fetch: '抓取网页',
  skill: '加载技能',
  present: '交付文件',
  todo_write: '更新任务清单',
  ask_user_question: '向你确认',
  create_goal: '创建目标',
  get_goal: '读取目标',
  update_goal: '更新目标',
  exit_plan_mode: '提交计划',
  list_agents: '查看子代理',
  send_message: '给子代理发消息',
  interrupt_agent: '中断子代理',
  job_list: '查看后台任务',
  job_output: '读取任务输出',
  job_kill: '终止后台任务',
  lsp: '查询语言服务',
  plugin_manager: '管理插件',
  session_search: '检索历史会话',
  session_trace: '查看历史轨迹',
  session_event_search: '检索历史事件',
  session_event_trace: '查看历史事件',
  list_mcp_resources: '读取 MCP 资源',
  read_mcp_resource: '读取 MCP 资源',
  list_mcp_resource_templates: '读取 MCP 模板',
  list_subagent_models: '查看子代理模型',
  spawn_teammate: '派生子代理',
  team_task_create: '创建协作任务',
  team_task_get: '读取协作任务',
  team_task_list: '查看协作任务',
  team_task_update: '更新协作任务',
  wait_agent: '等待子代理',
  terminal_open: '打开终端',
  terminal_read: '读取终端',
  terminal_send: '向终端输入',
  terminal_signal: '向终端发信号',
  terminal_close: '关闭终端',
  terminal_list: '查看终端',
  cordis_inspect_list: '查看插件清单',
  cordis_inspect_query: '查询插件',
  ralph: '循环迭代',
}

/** 工具入参里最像「对象」的键，按优先级取值作为动作宾语。 */
const TARGET_KEYS: readonly string[] = [
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'command',
  'cmd',
  'url',
  'name',
  'id',
  'task',
  'goal',
]

export function toolActionLabel(toolName: string): string {
  const known = TOOL_ACTIONS[toolName]
  if (known !== undefined) return known
  const humanized = toolName.replace(/_/g, ' ').trim()
  return humanized === '' ? '调用工具' : humanized
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 从句柄里挑一个可读的宾语（找不到返回空串）。 */
export function toolTarget(input: Readonly<Record<string, unknown>>): string {
  for (const key of TARGET_KEYS) {
    const text = asText(input[key])
    if (text !== null) return text
  }
  return ''
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`
}

export interface StepAction {
  /** 完整人话动作，如「读取文件 README.md」/「读取文件 等 4 项操作」。 */
  readonly text: string
  /** 第一个工具的动作短语（用于图标/分组）。 */
  readonly primary: string
  /** 工具调用次数。 */
  readonly count: number
}

/**
 * 由工具调用派生「这一步做了什么」。
 * 无工具调用时退化为「生成回复」——它确实只产出文本。
 */
export function describeStepAction(
  step: Pick<StepRecord, 'toolCalls' | 'status'>,
  max = 60,
): StepAction {
  const calls = step.toolCalls
  if (calls.length === 0) {
    return {
      text: step.status === 'running' ? '正在生成回复' : '生成回复',
      primary: '生成回复',
      count: 0,
    }
  }

  const first = calls[0]
  if (first === undefined) {
    return { text: '生成回复', primary: '生成回复', count: 0 }
  }
  const primary = toolActionLabel(first.toolName)
  const target = toolTarget(first.input)

  if (calls.length === 1) {
    return {
      text: truncate(target === '' ? primary : `${primary} ${target}`, max),
      primary,
      count: 1,
    }
  }

  const tail = target === '' ? '' : ` · ${truncate(target, 18)}`
  return {
    text: truncate(`${primary} 等 ${calls.length} 项操作${tail}`, max),
    primary,
    count: calls.length,
  }
}

/** 单个工具调用的一行人话（时间线工具行 / 详情列表用）。 */
export function describeToolCall(tool: ToolCallRecord, max = 60): string {
  const label = toolActionLabel(tool.toolName)
  const target = toolTarget(tool.input)
  return truncate(target === '' ? label : `${label} ${target}`, max)
}

/** 去掉行首的 markdown 记号（`- `、`1. `、`#`），摘要里不需要它们。 */
function stripMarkers(line: string): string {
  return line.replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+)/, '').trim()
}

/**
 * 思考摘要：取第一段有内容的文字，压平空白，并在句读处收口。
 *
 * 思考原文常常是「先讲背景，再分点列计划」的长文；一行摘要只需要第一句，
 * 全文交给详情面板与展开态（真相源不截断）。
 */
export function summarizeThinking(text: string, max = 96): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => stripMarkers(line))
      .find((line) => line !== '') ?? ''
  const flat = firstLine.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat

  const window = flat.slice(0, max)
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('；'),
    window.lastIndexOf('. '),
  )
  if (boundary >= max * 0.4) return window.slice(0, boundary + 1)
  // 省略号也算进上限：调用方给的是「这一行最长多少」，不该由标点突破。
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** 思考规模统计（行数 / 字数），用于「展开」按钮上的提示。 */
export function thinkingSize(text: string): { readonly chars: number; readonly lines: number } {
  const trimmed = text.trim()
  if (trimmed === '') return { chars: 0, lines: 0 }
  return { chars: trimmed.length, lines: trimmed.split('\n').length }
}

/**
 * 轮次序号：turn id 形如 `${sessionId}:t${n}`（PROTOCOL §4）。
 * 解析失败时退回「在可见列表里的位置 + 1」，保证永远有可读标题。
 */
export function turnOrdinal(turnId: string, fallbackIndex: number): number {
  const matched = /:t(\d+)$/.exec(turnId.trim())
  if (matched !== null) {
    const parsed = Number.parseInt(matched[1] ?? '', 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallbackIndex + 1
}

/** 提问摘要：单行、限长（时间线轮次标题用）。 */
export function summarizeMessage(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return '（等待提问）'
  return truncate(flat, max)
}

export const TONE_STATUS_LABELS = {
  pending: '待开始',
  running: '进行中',
  ok: '完成',
  error: '失败',
} as const
