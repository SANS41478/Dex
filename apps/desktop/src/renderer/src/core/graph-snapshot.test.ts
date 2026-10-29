import { describe, expect, it } from 'vitest'
import type { GraphLinkData, GraphNodeData } from './graph-data'
import { createGraphSnapshot, describeSnapshotSaveResult } from './graph-snapshot'

const nodes: GraphNodeData[] = [
  { id: 'a', label: 'a', type: 'tool', status: 'active' },
  { id: 'b', label: 'b', type: 'model', status: 'inactive', x: 1, y: 2, z: 3 },
]

/**
 * `three-forcegraph` 会把 link 的 `source` / `target` 原地替换成**节点对象**，
 * 而 `sourceId` / `targetId` 保持字符串。这里如实模拟渲染库改写过后的形态。
 */
const renderedLinks = [
  {
    id: 'l1',
    type: 'inject',
    sourceId: 'a',
    targetId: 'b',
    source: nodes[0],
    target: nodes[1],
  },
] as unknown as GraphLinkData[]

const view = {
  camera: null,
  visibleTypes: ['tool', 'model'] as const,
  focusOnly: false,
  selectedNodeId: null,
}

describe('createGraphSnapshot', () => {
  it('渲染库改写过 source/target 之后仍然可导出（D13 回归）', () => {
    // 原实现把渲染数据直接喂进 schema 的 `.parse()`，source/target 是对象而非字符串，
    // 必然抛 ZodError —— 表现为「点导出 JSON 没有任何反应」。
    const snapshot = createGraphSnapshot(nodes, renderedLinks, {
      ...view,
      visibleTypes: [...view.visibleTypes],
    })
    expect(snapshot.links).toEqual([{ id: 'l1', type: 'inject', source: 'a', target: 'b' }])
  })

  it('节点上的渲染字段（x/y/z）不会带进快照', () => {
    const snapshot = createGraphSnapshot(nodes, renderedLinks, {
      ...view,
      visibleTypes: [...view.visibleTypes],
    })
    for (const node of snapshot.nodes) {
      expect(node).not.toHaveProperty('x')
      expect(node).not.toHaveProperty('y')
      expect(node).not.toHaveProperty('z')
    }
  })

  it('空图谱可导出', () => {
    const snapshot = createGraphSnapshot([], [], {
      camera: null,
      visibleTypes: [],
      focusOnly: false,
      selectedNodeId: null,
    })
    expect(snapshot.nodes).toEqual([])
    expect(snapshot.links).toEqual([])
  })
})

describe('describeSnapshotSaveResult', () => {
  it('取消与落盘分别给出一句话', () => {
    expect(describeSnapshotSaveResult({ canceled: true })).toBe('已取消导出')
    expect(describeSnapshotSaveResult({ canceled: false, path: 'C:/tmp/a.json' })).toBe(
      '已导出到 C:/tmp/a.json',
    )
    expect(describeSnapshotSaveResult(undefined)).toBe('已导出')
  })
})
