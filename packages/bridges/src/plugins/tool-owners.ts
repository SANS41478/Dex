/**
 * 工具调用 → 插件条目（`pluginId`，与 M1 图谱节点 id 对齐）的解析表。
 *
 * 为什么必须自研（M2-03，2026-09-19 核对 dsh 0.1.6-alpha.2 源码）：
 * - `tool/call` 事件载荷只有 `{ turn, step, callId, name, arguments }`，不含提供方；
 * - `ctx.tools` 注册表公开面只有 `register / view / get / guard / restrict`，注册落在
 *   global 层（按 agent scope 分层），不暴露 owner fiber/包名；
 * - 官方 UI（`dsh-client-ui-tool`）也是按工具名硬编码选择视图，不存在通用映射。
 * 因此维护「工具名 → 候选包名」静态表，用 loader 条目（`options.name` → `entry.id`）反查；
 * 同名工具（`bash` 有常驻/一次性两种实现）按候选顺序取第一个在场包；未命中回退 `unknown`。
 *
 * 表来源：源码扫描 `defineTool({ name: ... })`（0.1.6-alpha.2 各 `tool-*` 包的 src）。
 */
export const UNKNOWN_PLUGIN_ID = 'unknown'

/** 工具名 → 候选插件包（loader `options.name`），按优先级排列。 */
export const TOOL_OWNERS: Readonly<Record<string, readonly string[]>> = {
  ask_user_question: ['@deepseek-ai/dsh-tool-ask-user'],
  bash: ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-bash-persistent'],
  cordis_inspect_list: ['@deepseek-ai/dsh-tool-cordis'],
  cordis_inspect_query: ['@deepseek-ai/dsh-tool-cordis'],
  create_goal: ['@deepseek-ai/dsh-tool-goal'],
  edit: ['@deepseek-ai/dsh-tool-fs'],
  exit_plan_mode: ['@deepseek-ai/dsh-plan-mode'],
  get_goal: ['@deepseek-ai/dsh-tool-goal'],
  glob: ['@deepseek-ai/dsh-tool-fs-search'],
  grep: ['@deepseek-ai/dsh-tool-fs-search'],
  interrupt_agent: ['@deepseek-ai/dsh-tool-subagent-control'],
  job_kill: ['@deepseek-ai/dsh-tool-jobs'],
  job_list: ['@deepseek-ai/dsh-tool-jobs'],
  job_output: ['@deepseek-ai/dsh-tool-jobs'],
  list_agents: ['@deepseek-ai/dsh-tool-subagent-control'],
  list_mcp_resource_templates: ['@deepseek-ai/dsh-mcp-resources'],
  list_mcp_resources: ['@deepseek-ai/dsh-mcp-resources'],
  list_subagent_models: ['@deepseek-ai/dsh-tool-subagent'],
  lsp: ['@deepseek-ai/dsh-tool-lsp'],
  plugin_manager: ['@deepseek-ai/dsh-plugin-manager'],
  present: ['@deepseek-ai/dsh-tool-present'],
  pwsh: ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-pwsh-persistent'],
  ralph: ['@deepseek-ai/dsh-tool-ralph'],
  read: ['@deepseek-ai/dsh-tool-fs'],
  read_image: ['@deepseek-ai/dsh-tool-fs'],
  read_mcp_resource: ['@deepseek-ai/dsh-mcp-resources'],
  run_code: ['@deepseek-ai/dsh-tools'],
  send_message: ['@deepseek-ai/dsh-tool-subagent-control'],
  session_event_search: ['@deepseek-ai/dsh-tool-session-query'],
  session_event_trace: ['@deepseek-ai/dsh-tool-session-query'],
  session_search: ['@deepseek-ai/dsh-tool-session-query'],
  session_trace: ['@deepseek-ai/dsh-tool-session-query'],
  skill: ['@deepseek-ai/dsh-tool-skill'],
  spawn_teammate: ['@deepseek-ai/dsh-experimental-tool-agent-team'],
  str_replace_editor: ['@deepseek-ai/dsh-tool-str-replace-editor'],
  team_task_create: ['@deepseek-ai/dsh-experimental-tool-agent-team'],
  team_task_get: ['@deepseek-ai/dsh-experimental-tool-agent-team'],
  team_task_list: ['@deepseek-ai/dsh-experimental-tool-agent-team'],
  team_task_update: ['@deepseek-ai/dsh-experimental-tool-agent-team'],
  terminal_close: ['@deepseek-ai/dsh-tool-terminal'],
  terminal_list: ['@deepseek-ai/dsh-tool-terminal'],
  terminal_open: ['@deepseek-ai/dsh-tool-terminal'],
  terminal_read: ['@deepseek-ai/dsh-tool-terminal'],
  terminal_send: ['@deepseek-ai/dsh-tool-terminal'],
  terminal_signal: ['@deepseek-ai/dsh-tool-terminal'],
  todo_write: ['@deepseek-ai/dsh-tool-todo'],
  update_goal: ['@deepseek-ai/dsh-tool-goal'],
  wait_agent: ['@deepseek-ai/dsh-experimental-tool-agent-team'],
  web_fetch: ['@deepseek-ai/dsh-tool-web'],
  web_search: ['@deepseek-ai/dsh-tool-web'],
  write: ['@deepseek-ai/dsh-tool-fs'],
}

/** loader 条目的最小形状（`options.name` 经 `adaptEntry` 收口为 `moduleName`）。 */
export interface ToolOwnerEntryLike {
  readonly id: string
  readonly moduleName?: string | undefined
}

/**
 * 构造 `pluginId` 解析器：按静态表找候选包，再在当前 loader 条目里取第一个在场包条目的 id。
 * 条目读取函数每次调用时求值（loader 条目会随插件增删变化）。
 */
export function createToolOwnerResolver(
  readEntries: () => Iterable<ToolOwnerEntryLike>,
): (toolName: string) => string {
  return (toolName) => {
    const candidates = TOOL_OWNERS[toolName]
    if (candidates === undefined) return UNKNOWN_PLUGIN_ID
    const entries = [...readEntries()]
    for (const moduleName of candidates) {
      const entry = entries.find((item) => item.moduleName === moduleName)
      if (entry !== undefined) return entry.id
    }
    return UNKNOWN_PLUGIN_ID
  }
}
