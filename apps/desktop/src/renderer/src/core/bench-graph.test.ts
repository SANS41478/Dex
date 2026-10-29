import { describe, expect, it } from 'vitest'
import { generateSyntheticGraph } from './bench-graph'

describe('generateSyntheticGraph', () => {
  it('默认 500 节点、边只引用存在节点且 id 唯一', () => {
    const graph = generateSyntheticGraph()
    expect(graph.nodes).toHaveLength(500)

    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    expect(nodeIds.size).toBe(500)

    const linkIds = new Set(graph.links.map((link) => link.id))
    expect(linkIds.size).toBe(graph.links.length)
    for (const link of graph.links) {
      expect(nodeIds.has(link.source), `${link.id} source`).toBe(true)
      expect(nodeIds.has(link.target), `${link.id} target`).toBe(true)
    }
    expect(graph.links.length).toBeGreaterThan(500)
  })

  it('同种子可复现；状态与类型有多样性', () => {
    const a = generateSyntheticGraph(50, 7)
    const b = generateSyntheticGraph(50, 7)
    expect(a).toEqual(b)

    expect(new Set(a.nodes.map((node) => node.type)).size).toBeGreaterThan(1)
    expect(new Set(a.nodes.map((node) => node.status)).size).toBeGreaterThan(1)
  })
})
