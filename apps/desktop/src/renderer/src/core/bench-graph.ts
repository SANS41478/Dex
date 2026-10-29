import type { GraphLink, GraphNode, PluginType } from '@dexagent/shared'

export interface SyntheticGraph {
  nodes: GraphNode[]
  links: GraphLink[]
}

const TYPES: readonly PluginType[] = ['model', 'tool', 'skill', 'scheduler', 'sandbox', 'other']

/** 确定性 PRNG（mulberry32）：基准数据可复现，不受随机源影响。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 生成基准用合成图（默认 500 节点）：环 + 随机附加边的连图，
 * 保证 id 唯一、边只引用存在节点、类型/状态有多样性。
 */
export function generateSyntheticGraph(nodeCount = 500, seed = 42): SyntheticGraph {
  const random = mulberry32(seed)
  const nodes: GraphNode[] = []
  for (let index = 0; index < nodeCount; index += 1) {
    const roll = random()
    const status = roll < 0.9 ? 'active' : roll < 0.95 ? 'inactive' : 'error'
    nodes.push({
      id: `bench-node-${index}`,
      label: `bench-node-${index}`,
      type: TYPES[index % TYPES.length] ?? 'other',
      status,
    })
  }

  const links: GraphLink[] = []
  const seenLinkIds = new Set<string>()
  const pushLink = (source: number, target: number): void => {
    const id = `bench-link-${source}-${target}`
    if (seenLinkIds.has(id)) return
    seenLinkIds.add(id)
    links.push({
      id,
      source: `bench-node-${source}`,
      target: `bench-node-${target}`,
      type: 'inject',
    })
  }

  for (let index = 0; index < nodeCount; index += 1) {
    pushLink(index, (index + 1) % nodeCount)
  }
  const extra = Math.max(0, Math.round(nodeCount * 0.4))
  for (let index = 0; index < extra; index += 1) {
    const source = Math.floor(random() * nodeCount)
    const target = Math.floor(random() * nodeCount)
    if (source !== target) pushLink(source, target)
  }

  return { nodes, links }
}
