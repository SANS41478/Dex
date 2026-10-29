import type { GraphNode, PluginType } from '@dexagent/shared'
import type { TurnRecord } from './trace'

/**
 * 「这个节点是什么、干什么用的」的人话说明（图谱详情摘要态用）。
 *
 * 数据源限制：loader 条目只给出 `id / moduleName / disabled / config*`（`dsh/adapt.ts`），
 * **没有**插件自述字段（package.json 的 description 不在投影里）。所以这里用
 * 「包名 → 能力短语」的静态表补上人话，未收录时回退到「类型 + 包名」的中性描述——
 * 宁可说「这是工具插件」，也不要编一句可能是假的用途。
 */

/** 已知 dsh 官方包 → 能力短语（来源：各 `tool-*` 包 `defineTool({name})` 与包职责）。 */
const PACKAGE_CAPABILITIES: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-tool-fs': '文件读写：read / write / edit / read_image',
  '@deepseek-ai/dsh-tool-fs-search': '文件搜索：glob / grep',
  '@deepseek-ai/dsh-tool-pwsh': '命令执行：pwsh',
  '@deepseek-ai/dsh-tool-pwsh-persistent': '常驻命令执行：pwsh（会话级进程复用）',
  '@deepseek-ai/dsh-tool-bash': '命令执行：bash',
  '@deepseek-ai/dsh-tool-bash-persistent': '常驻命令执行：bash（会话级进程复用）',
  '@deepseek-ai/dsh-tool-web': '联网检索：web_search / web_fetch',
  '@deepseek-ai/dsh-tool-todo': '任务清单：todo_write',
  '@deepseek-ai/dsh-tool-goal': '目标管理：create / get / update_goal',
  '@deepseek-ai/dsh-tool-jobs': '后台任务：列表 / 读输出 / 终止',
  '@deepseek-ai/dsh-tool-subagent': '子代理：模型选择与派生',
  '@deepseek-ai/dsh-tool-subagent-control': '子代理控制：列表 / 通信 / 中断',
  '@deepseek-ai/dsh-experimental-tool-agent-team': '协作团队：任务拆分与多人代理协同',
  '@deepseek-ai/dsh-tool-terminal': '终端会话：打开 / 读取 / 输入 / 关闭',
  '@deepseek-ai/dsh-tool-skill': '技能加载：按需注入领域操作手册',
  '@deepseek-ai/dsh-tool-present': '产物交付：把文件登记为交付物',
  '@deepseek-ai/dsh-tool-session-query': '历史会话检索与轨迹回看',
  '@deepseek-ai/dsh-tool-ask-user': '向你提问并等待答复',
  '@deepseek-ai/dsh-tool-lsp': '语言服务：符号与诊断查询',
  '@deepseek-ai/dsh-tool-cordis': 'Cordis 运行时观测：插件与依赖查询',
  '@deepseek-ai/dsh-tool-ralph': '循环迭代执行（ralph）',
  '@deepseek-ai/dsh-plan-mode': '计划模式：先出方案再动手',
  '@deepseek-ai/dsh-plugin-manager': '插件管理：清单与状态',
  '@deepseek-ai/dsh-mcp-resources': 'MCP 资源接入：列出 / 读取外部资源',
  '@deepseek-ai/dsh-sandbox-local': '本机沙箱：文件与命令的准入策略',
}

/** 包名片段 → 能力短语（精确表未命中时的第二层）。 */
const MODULE_CAPABILITIES: readonly (readonly [string, string])[] = [
  ['tool-fs-search', '文件搜索'],
  ['tool-fs', '文件读写'],
  ['tool-pwsh', '命令执行'],
  ['tool-bash', '命令执行'],
  ['tool-web', '联网检索'],
  ['tool-todo', '任务清单'],
  ['tool-goal', '目标管理'],
  ['tool-jobs', '后台任务'],
  ['tool-subagent', '子代理'],
  ['tool-terminal', '终端会话'],
  ['tool-session-query', '历史会话检索'],
  ['sandbox', '沙箱策略'],
  ['mcp', 'MCP 资源接入'],
  ['llm-', '模型接入'],
  ['session', '会话存储与投影'],
  ['skill', '技能'],
]

const TYPE_ROLES: Readonly<Record<PluginType, string>> = {
  model: '模型插件：向 Agent 提供 provider 与模型能力',
  tool: '工具插件：向模型暴露可调用的工具',
  skill: '技能插件：按需注入的领域操作手册',
  scheduler: '调度插件：按时间或事件驱动任务',
  sandbox: '沙箱插件：约束工具的文件与命令权限',
  other: '插件条目：Cordis 运行时中的一个装载单元',
}

const TYPE_LABELS: Readonly<Record<PluginType, string>> = {
  model: '模型',
  tool: '工具',
  skill: '技能',
  scheduler: '调度',
  sandbox: '沙箱',
  other: '其他',
}

export interface PluginBrief {
  /** 类型标签，如「工具」。 */
  readonly kindLabel: string
  /** 它在整个 Agent 里的角色（一句人话）。 */
  readonly role: string
  /** 具体能力短语；无法识别时为 `null`（不要编）。 */
  readonly capability: string | null
  /** 摘要态主句，如「文件读写 · 依赖 2 / 被依赖 5」。 */
  readonly summary: string
}

function capabilityOf(node: GraphNode): string | null {
  const moduleName = node.moduleName
  if (moduleName === undefined) return null
  const exact = PACKAGE_CAPABILITIES[moduleName]
  if (exact !== undefined) return exact
  const lowered = moduleName.toLowerCase()
  for (const [fragment, phrase] of MODULE_CAPABILITIES) {
    if (lowered.includes(fragment)) return phrase
  }
  return null
}

/**
 * 节点摘要：类型 + 能力 + 连接度。
 * `degree` 由调用方（图谱面板）提供，避免这里重算整张图。
 */
export function describePluginNode(
  node: GraphNode,
  degree: { readonly incoming: number; readonly outgoing: number },
): PluginBrief {
  const capability = capabilityOf(node)
  const links: string[] = []
  if (degree.incoming > 0) links.push(`依赖 ${degree.incoming}`)
  if (degree.outgoing > 0) links.push(`被依赖 ${degree.outgoing}`)
  const parts = [capability ?? TYPE_ROLES[node.type], ...links]
  return {
    kindLabel: TYPE_LABELS[node.type],
    role: TYPE_ROLES[node.type],
    capability,
    summary: parts.join(' · '),
  }
}

/** 本会话里该插件被调用的次数（图谱 → 执行流的连接点）。 */
export function countPluginUsage(turns: readonly TurnRecord[], pluginId: string): number {
  let count = 0
  for (const turn of turns) {
    for (const step of turn.steps) {
      for (const tool of step.toolCalls) {
        if (tool.pluginId === pluginId) count += 1
      }
    }
  }
  return count
}
