import type {
  ControlCapabilities,
  GraphLink,
  GraphNode,
  NodeStatus,
  PluginType,
} from '@dexagent/shared'
import type { DshLoaderEntry } from '../dsh/contract'
import { toFiberPhase } from '../dsh/contract'

/** 插件树快照：纯映射产物，尚未信封化。 */
export interface GraphSnapshot {
  nodes: GraphNode[]
  links: GraphLink[]
}

/**
 * 类型推断：dsh 插件按模块名约定分类；无法判定时用兜底类型 `other`（M1-03 已拍板）。
 * 顺序敏感（先特化后通用）；规则已用真实 dex profile 数据校准（M1-04b）。
 */
const TYPE_RULES: readonly { readonly pattern: RegExp; readonly type: PluginType }[] = [
  { pattern: /sandbox/, type: 'sandbox' },
  { pattern: /schedul|cron|timer/, type: 'scheduler' },
  { pattern: /tool/, type: 'tool' },
  { pattern: /skill/, type: 'skill' },
  { pattern: /llm|model|adapter/, type: 'model' },
]

const READ_ONLY_CAPABILITIES: ControlCapabilities = {
  canEnable: false,
  canDisable: false,
  canConfigure: false,
}

export function inferPluginType(moduleName: string | undefined): PluginType {
  if (moduleName === undefined || moduleName === '') return 'other'
  const name = moduleName.toLowerCase()
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(name)) return rule.type
  }
  return 'other'
}

/** label 取模块名去 scope 短名（如 `@deepseek-ai/dsh-tool-fs` → `dsh-tool-fs`）；缺省返回 null。 */
export function toNodeLabel(moduleName: string | undefined): string | null {
  if (moduleName === undefined || moduleName === '') return null
  if (!moduleName.startsWith('@')) return moduleName
  const segments = moduleName.split('/')
  return segments.length > 1 ? segments.slice(1).join('/') : moduleName
}

/** fiber 相位 / 禁用状态 → 节点状态；DISPOSED（uid=null）与无 fiber 都视为 inactive。 */
export function toNodeStatus(entry: DshLoaderEntry): NodeStatus {
  if (entry.disabled) return 'inactive'
  const fiber = entry.fiber
  if (fiber === undefined || fiber.uid === null) return 'inactive'
  switch (toFiberPhase(fiber.state)) {
    case 'active':
      return 'active'
    case 'failed':
      return 'error'
    default:
      return 'inactive'
  }
}

/** 分组条目（结构行）不产生节点；内建行缺模块名时 label 退回条目 id。 */
export function entryToNode(entry: DshLoaderEntry): GraphNode | null {
  if (entry.group) return null
  const node: GraphNode = {
    id: entry.id,
    label: toNodeLabel(entry.moduleName) ?? entry.id,
    type: inferPluginType(entry.moduleName),
    status: toNodeStatus(entry),
    disabled: entry.disabled,
    controlCapabilities: READ_ONLY_CAPABILITIES,
  }
  const withModule =
    entry.moduleName === undefined || entry.moduleName === ''
      ? node
      : { ...node, moduleName: entry.moduleName }
  if (entry.configReadable === undefined) return withModule
  return {
    ...withModule,
    configReadable: entry.configReadable,
    ...(entry.configKeys === undefined ? {} : { configKeys: [...entry.configKeys] }),
  }
}

/** 边 id 只由消费方与服务名决定：提供方变化时原地更新，不产生删/增抖动。 */
export function injectLinkId(sourceId: string, serviceKey: string): string {
  return `inject:${sourceId}:${serviceKey}`
}

/**
 * 条目树 → 图快照。
 * 边来源：fiber 已解析依赖（`store`）反查提供方条目；无法定位（根服务 / 树外 fiber / 自环）时跳过。
 */
export function buildGraph(entries: Iterable<DshLoaderEntry>): GraphSnapshot {
  const list = [...entries].filter((entry) => !entry.group)

  const uidToNodeId = new Map<number, string>()
  for (const entry of list) {
    const uid = entry.fiber?.uid
    if (uid !== undefined && uid !== null) uidToNodeId.set(uid, entry.id)
  }

  const nodes: GraphNode[] = []
  for (const entry of list) {
    const node = entryToNode(entry)
    if (node !== null) nodes.push(node)
  }

  const links: GraphLink[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const store = entry.fiber?.store
    if (store === undefined) continue
    for (const [serviceKey, providerUid] of Object.entries(store)) {
      const target = providerUid === null ? undefined : uidToNodeId.get(providerUid)
      if (target === undefined || target === entry.id) continue
      const id = injectLinkId(entry.id, serviceKey)
      if (seen.has(id)) continue
      seen.add(id)
      links.push({ id, source: entry.id, target, type: 'inject' })
    }
  }

  return { nodes, links }
}
