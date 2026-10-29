import type { GraphLink, GraphNode } from './domain'
import type { GraphMessage } from './protocol'

/** 图谱状态：协议消息折叠出的当前图（renderer 与 main 共用）。 */
export interface GraphState {
  nodes: GraphNode[]
  links: GraphLink[]
}

export const initialGraphState: GraphState = {
  nodes: [],
  links: [],
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) merged.set(item.id, item)
  return [...merged.values()]
}

/** 折叠一条图谱协议消息 → 新状态（纯函数；快照替换，upsert 合并，remove 删除）。 */
export function applyGraphMessage(state: GraphState, message: GraphMessage): GraphState {
  switch (message.type) {
    case 'graph.snapshot':
      return { nodes: message.payload.nodes, links: message.payload.links }

    case 'graph.upsert':
      return {
        nodes: mergeById(state.nodes, message.payload.nodes),
        links: mergeById(state.links, message.payload.links),
      }

    case 'graph.remove':
      return {
        nodes: state.nodes.filter((node) => !message.payload.nodeIds.includes(node.id)),
        links: state.links.filter((link) => !message.payload.linkIds.includes(link.id)),
      }

    default:
      return state
  }
}
