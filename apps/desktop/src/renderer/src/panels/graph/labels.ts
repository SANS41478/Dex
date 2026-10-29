import type { NodeStatus, PluginType } from '@dexagent/shared'

/** UI 展示用中文标签（业务映射在 core，这里只做展示字典）。 */
export const TYPE_LABELS: Record<PluginType, string> = {
  model: '模型',
  tool: '工具',
  skill: '技能',
  scheduler: '调度',
  sandbox: '沙箱',
  other: '其他',
}

export const TYPE_ORDER: readonly PluginType[] = [
  'model',
  'tool',
  'skill',
  'scheduler',
  'sandbox',
  'other',
]

export const STATUS_LABELS: Record<NodeStatus, string> = {
  active: '已启用',
  inactive: '未启用',
  error: '异常',
}
