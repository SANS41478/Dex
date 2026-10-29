import { describe, expect, it } from 'vitest'
import {
  applyGraphUpdate,
  createGraphData,
  type GraphData,
  pinSettledNodes,
  releasePins,
  toRenderLink,
} from './graph-data'

const node = (
  id: string,
  overrides: Partial<{ label: string; status: 'active' | 'error' }> = {},
) => ({
  id,
  label: overrides.label ?? id,
  type: 'tool' as const,
  status: overrides.status ?? ('active' as const),
})

const link = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
  type: 'inject' as const,
})

/** 模拟渲染库：把 scratch 端点上写成对象（并保留不可变 sourceId/targetId）。 */
function mutateEndpointsLikeLibrary(data: GraphData): void {
  for (const item of data.links) {
    ;(item as unknown as { source: unknown }).source = { id: item.sourceId }
    ;(item as unknown as { target: unknown }).target = { id: item.targetId }
  }
}

describe('applyGraphUpdate', () => {
  it('新增节点/边是结构性变化；字段更新是内容变化', () => {
    const data: GraphData = createGraphData()
    expect(applyGraphUpdate(data, { nodes: [node('a'), node('b')], links: [] })).toEqual({
      structural: true,
      content: false,
    })

    const added = applyGraphUpdate(data, {
      nodes: [node('a'), node('b')],
      links: [link('l1', 'a', 'b')],
    })
    expect(added.structural).toBe(true)

    const contentOnly = applyGraphUpdate(data, {
      nodes: [node('a', { status: 'error' }), node('b')],
      links: [link('l1', 'a', 'b')],
    })
    expect(contentOnly).toEqual({ structural: false, content: true })
    expect(data.nodes[0]?.status).toBe('error')

    expect(
      applyGraphUpdate(data, {
        nodes: [node('a', { status: 'error' }), node('b')],
        links: [link('l1', 'a', 'b')],
      }),
    ).toEqual({ structural: false, content: false })
  })

  it('渲染库替换端点对象后，不会误判为变化，也不会回写 scratch 字段', () => {
    const data: GraphData = createGraphData()
    applyGraphUpdate(data, { nodes: [node('a'), node('b')], links: [link('l1', 'a', 'b')] })
    mutateEndpointsLikeLibrary(data)

    const result = applyGraphUpdate(data, {
      nodes: [node('a'), node('b')],
      links: [link('l1', 'a', 'b')],
    })
    expect(result).toEqual({ structural: false, content: false })

    const renderLink = data.links[0]
    expect(renderLink?.sourceId).toBe('a')
    expect(renderLink?.targetId).toBe('b')
    // scratch 字段保持库写下的对象（我们不再回写字符串）
    expect(typeof renderLink?.source).toBe('object')
  })

  it('端点变化是结构性变化，并把 scratch 归零为 id 字符串', () => {
    const data: GraphData = createGraphData()
    applyGraphUpdate(data, {
      nodes: [node('a'), node('b'), node('c')],
      links: [link('l1', 'a', 'b')],
    })
    const result = applyGraphUpdate(data, {
      nodes: [node('a'), node('b'), node('c')],
      links: [link('l1', 'a', 'c')],
    })
    expect(result.structural).toBe(true)
    expect(data.links[0]?.targetId).toBe('c')
    expect(data.links[0]?.target).toBe('c')
  })

  it('结构性变化换数组引用（防引擎读到未重解析的 scratch），节点对象引用保持', () => {
    // 回归（2026-10-08，UI-10）：原地 splice/push 会让运行中的 d3 引擎读到
    // 新 link 的字符串 scratch 端点 → `Cannot create property 'vx' on string`。
    const data: GraphData = createGraphData()
    applyGraphUpdate(data, { nodes: [node('a'), node('b')], links: [] })
    const nodeA = data.nodes.find((item) => item.id === 'a')
    const linksBefore = data.links

    // 新增边是结构变化：links 数组换新引用，节点对象引用保持。
    applyGraphUpdate(data, { nodes: [node('a'), node('b')], links: [link('l1', 'a', 'b')] })
    expect(data.links).not.toBe(linksBefore)
    expect(data.nodes.find((item) => item.id === 'a')).toBe(nodeA)

    // 纯内容变化两数组都不换引用（避免无谓重排）。
    const nodesAfterStructural = data.nodes
    const linksAfterStructural = data.links
    applyGraphUpdate(data, {
      nodes: [node('a', { status: 'error' }), node('b')],
      links: [link('l1', 'a', 'b')],
    })
    expect(data.nodes).toBe(nodesAfterStructural)
    expect(data.links).toBe(linksAfterStructural)
  })

  it('移除节点并剪掉悬空边；忽略指向不存在节点的边', () => {
    const data: GraphData = createGraphData()
    applyGraphUpdate(data, { nodes: [node('a'), node('b')], links: [link('l1', 'a', 'b')] })

    const removed = applyGraphUpdate(data, { nodes: [node('b')], links: [] })
    expect(removed.structural).toBe(true)
    expect(data.nodes.map((item) => item.id)).toEqual(['b'])
    expect(data.links).toEqual([])

    applyGraphUpdate(data, { nodes: [node('b')], links: [link('l9', 'b', 'ghost')] })
    expect(data.links).toEqual([])
  })

  it('toRenderLink 保留不可变 id 与 scratch 初值', () => {
    expect(toRenderLink(link('l1', 'a', 'b'))).toEqual({
      id: 'l1',
      type: 'inject',
      sourceId: 'a',
      targetId: 'b',
      source: 'a',
      target: 'b',
    })
  })
})

describe('pinSettledNodes / releasePins', () => {
  it('固定有坐标且未固定的节点；releasePins 清空固定态', () => {
    const data: GraphData = createGraphData()
    applyGraphUpdate(data, { nodes: [node('a'), node('b'), node('c')], links: [] })
    const [a, b, c] = data.nodes
    if (a === undefined || b === undefined || c === undefined) throw new Error('expected nodes')

    a.x = 1
    a.y = 2
    a.z = 3
    c.x = 4
    c.y = 5
    c.z = 6
    c.fx = 4

    expect(pinSettledNodes(data)).toBe(1)
    expect(a.fx).toBe(1)
    expect(c.fy).toBeUndefined()
    expect(pinSettledNodes(data)).toBe(0)

    expect(releasePins(data)).toBe(2)
    expect(a.fx).toBeUndefined()
    expect(c.fz).toBeUndefined()
    expect(releasePins(data)).toBe(0)
  })
})
