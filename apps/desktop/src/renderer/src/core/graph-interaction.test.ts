import { describe, expect, it } from 'vitest'
import {
  cameraViewSchema,
  computeDegrees,
  countTypes,
  edgeSummaries,
  filterGraph,
  linkEnds,
  matchesQuery,
  neighborsOf,
  parseCameraView,
  serializeCameraView,
  subgraphOf,
} from './graph-interaction'

const node = (id: string, type: 'tool' | 'model', extra: Partial<{ moduleName: string }> = {}) => ({
  id,
  label: `label-${id}`,
  type,
  status: 'active' as const,
  ...extra,
})

const link = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
  type: 'inject' as const,
})

describe('matchesQuery', () => {
  it('匹配 label / id / moduleName，忽略大小写与首尾空白', () => {
    const target = node('tool-fs', 'tool', { moduleName: '@deepseek-ai/dsh-tool-fs' })
    expect(matchesQuery(target, '  LABEL-TOOL-FS ')).toBe(true)
    expect(matchesQuery(target, 'tool-fs')).toBe(true)
    expect(matchesQuery(target, 'dsh-tool')).toBe(true)
    expect(matchesQuery(target, 'missing')).toBe(false)
    expect(matchesQuery(target, '   ')).toBe(false)
  })
})

describe('filterGraph', () => {
  it('按类型剔除节点与悬空边，且保留对象引用（坐标不丢）', () => {
    const a = node('a', 'tool')
    const b = node('b', 'model')
    const graph = { nodes: [a, b], links: [link('l1', 'a', 'b')] }

    const onlyTools = filterGraph(graph.nodes, graph.links, new Set(['tool']))
    expect(onlyTools.nodes.map((item) => item.id)).toEqual(['a'])
    expect(onlyTools.nodes[0]).toBe(a)
    expect(onlyTools.links).toEqual([])

    const all = filterGraph(graph.nodes, graph.links, new Set(['tool', 'model']))
    expect(all.nodes).toHaveLength(2)
    expect(all.links.map((item) => item.id)).toEqual(['l1'])
  })
})

describe('countTypes', () => {
  it('按类型计数且六类键齐全', () => {
    const counts = countTypes([node('a', 'tool'), node('b', 'model'), node('c', 'tool')])
    expect(counts).toEqual({ model: 1, tool: 2, skill: 0, scheduler: 0, sandbox: 0, other: 0 })
  })
})

describe('linkEnds / 渲染库端点替换后的纯函数', () => {
  const renderLink = (id: string, sourceId: string, targetId: string, mutate = false) => {
    const link = {
      id,
      type: 'inject' as const,
      sourceId,
      targetId,
      source: sourceId,
      target: targetId,
    }
    if (mutate) {
      ;(link as unknown as { source: unknown }).source = { id: sourceId }
      ;(link as unknown as { target: unknown }).target = { id: targetId }
    }
    return link
  }

  it('linkEnds 优先不可变 id；端点为对象时返回 null（无 id 字段的旧数据）', () => {
    expect(linkEnds(renderLink('l1', 'a', 'b'))).toEqual({ sourceId: 'a', targetId: 'b' })
    expect(linkEnds({ id: 'l2', source: 'x', target: 'y', type: 'inject' })).toEqual({
      sourceId: 'x',
      targetId: 'y',
    })
    const broken = { id: 'l3', source: {}, target: {}, type: 'inject' } as unknown as Parameters<
      typeof linkEnds
    >[0]
    expect(linkEnds(broken)).toBeNull()
  })

  it('端点被库替换成对象后：过滤 / 度数 / 邻居 / 子图 / 详情仍正确', () => {
    const a = node('a', 'tool')
    const b = node('b', 'model', { moduleName: '@x/plugin-b' })
    const c = node('c', 'tool')
    const links = [renderLink('l1', 'a', 'b', true), renderLink('l2', 'a', 'c', true)]
    const nodesById = new Map([a, b, c].map((item) => [item.id, item]))

    const filtered = filterGraph([a, b, c], links, new Set(['tool', 'model']))
    expect(filtered.links.map((item) => item.id)).toEqual(['l1', 'l2'])
    // 只留「工具」时：a→c 两端都可见而保留，a→b（b 是模型）被剔除
    expect(filterGraph([a, b, c], links, new Set(['tool'])).links.map((item) => item.id)).toEqual([
      'l2',
    ])

    const degrees = computeDegrees([a, b, c], links)
    expect(degrees.get('a')).toBe(2)
    expect([...neighborsOf('a', links)].sort()).toEqual(['b', 'c'])
    expect([...subgraphOf('a', [a, b, c], links, 1)].sort()).toEqual(['a', 'b', 'c'])

    const summaries = edgeSummaries('a', links, nodesById)
    expect(summaries.outgoing.map((edge) => edge.nodeId)).toEqual(['b', 'c'])
    expect(summaries.incoming).toEqual([])
  })
})

describe('computeDegrees / neighborsOf', () => {
  it('度数含入边与出边，重复边计数；邻居双向可达', () => {
    const nodes = [node('a', 'tool'), node('b', 'model'), node('c', 'tool')]
    const links = [link('l1', 'a', 'b'), link('l2', 'a', 'c'), link('l3', 'b', 'c')]
    const degrees = computeDegrees(nodes, links)
    expect(degrees.get('a')).toBe(2)
    expect(degrees.get('b')).toBe(2)
    expect(degrees.get('c')).toBe(2)

    expect([...neighborsOf('a', links)].sort()).toEqual(['b', 'c'])
    expect([...neighborsOf('missing', links)]).toEqual([])
  })
})

describe('subgraphOf（聚焦子图）', () => {
  const nodes = [node('a', 'tool'), node('b', 'model'), node('c', 'tool'), node('d', 'tool')]
  const links = [link('l1', 'a', 'b'), link('l2', 'b', 'c')]

  it('1 跳 = 根 + 直接邻居；2 跳扩展一层', () => {
    expect([...subgraphOf('a', nodes, links, 1)].sort()).toEqual(['a', 'b'])
    expect([...subgraphOf('a', nodes, links, 2)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('孤立节点只含自身；根不存在返回空集', () => {
    expect([...subgraphOf('d', nodes, links, 1)]).toEqual(['d'])
    expect([...subgraphOf('ghost', nodes, links, 1)]).toEqual([])
  })
})

describe('edgeSummaries', () => {
  it('区分入边与出边，缺模块名时 moduleName 为 null', () => {
    const nodes = [node('a', 'tool'), node('b', 'model', { moduleName: '@x/plugin-b' })]
    const nodesById = new Map(nodes.map((item) => [item.id, item]))
    const links = [link('l1', 'a', 'b'), link('l2', 'b', 'a'), link('l3', 'a', 'ghost')]

    const { incoming, outgoing } = edgeSummaries('a', links, nodesById)
    expect(incoming).toEqual([
      { linkId: 'l2', nodeId: 'b', label: 'label-b', moduleName: '@x/plugin-b' },
    ])
    expect(outgoing).toEqual([
      { linkId: 'l1', nodeId: 'b', label: 'label-b', moduleName: '@x/plugin-b' },
    ])
  })
})

describe('camera view 持久化', () => {
  it('往返一致；损坏输入返回 null', () => {
    const view = {
      position: { x: 1, y: 2, z: 3 },
      lookAt: { x: 0, y: 0, z: 0 },
    }
    expect(cameraViewSchema.safeParse(view).success).toBe(true)
    expect(parseCameraView(serializeCameraView(view))).toEqual(view)

    expect(parseCameraView(null)).toBeNull()
    expect(parseCameraView('')).toBeNull()
    expect(parseCameraView('not json')).toBeNull()
    expect(parseCameraView('{"position":{"x":1}}')).toBeNull()
  })
})
