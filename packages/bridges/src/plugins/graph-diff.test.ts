import type { GraphLink, GraphNode } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { diffGraph } from './graph-diff'

const node = (id: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  label: id,
  type: 'tool',
  status: 'active',
  ...overrides,
})

const link = (id: string, overrides: Partial<GraphLink> = {}): GraphLink => ({
  id,
  source: 'a',
  target: 'b',
  type: 'inject',
  ...overrides,
})

describe('diffGraph', () => {
  it('两棵树相同 → null（不发消息）', () => {
    const snapshot = { nodes: [node('a'), node('b')], links: [link('inject:a:b')] }
    expect(
      diffGraph(snapshot, { nodes: [...snapshot.nodes], links: [...snapshot.links] }),
    ).toBeNull()
  })

  it('新增节点 / 新增边进入 upsert', () => {
    const patch = diffGraph(
      { nodes: [node('a')], links: [] },
      { nodes: [node('a'), node('b')], links: [link('inject:b:a')] },
    )
    expect(patch).toEqual({
      upsert: { nodes: [node('b')], links: [link('inject:b:a')] },
      remove: { nodeIds: [], linkIds: [] },
    })
  })

  it('状态或内容变化进入 upsert', () => {
    const patch = diffGraph(
      { nodes: [node('a')], links: [] },
      { nodes: [node('a', { status: 'error', label: 'renamed' })], links: [] },
    )
    expect(patch?.upsert.nodes).toEqual([node('a', { status: 'error', label: 'renamed' })])
    expect(patch?.remove.nodeIds).toEqual([])
  })

  it('条目移除 → 节点与其关联边一起进 remove', () => {
    const patch = diffGraph(
      { nodes: [node('a'), node('b')], links: [link('inject:a:b')] },
      { nodes: [node('a')], links: [] },
    )
    expect(patch).toEqual({
      upsert: { nodes: [], links: [] },
      remove: { nodeIds: ['b'], linkIds: ['inject:a:b'] },
    })
  })

  it('提供方变化只更新边，不换 id（增量稳定）', () => {
    const patch = diffGraph(
      { nodes: [node('a'), node('b'), node('c')], links: [link('inject:a:b')] },
      { nodes: [node('a'), node('b'), node('c')], links: [link('inject:a:b', { target: 'c' })] },
    )
    expect(patch).toEqual({
      upsert: { nodes: [], links: [link('inject:a:b', { target: 'c' })] },
      remove: { nodeIds: [], linkIds: [] },
    })
  })
})
