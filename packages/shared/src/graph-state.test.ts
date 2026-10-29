import { describe, expect, it } from 'vitest'
import type { GraphLink, GraphNode } from './domain'
import { applyGraphMessage, initialGraphState } from './graph-state'
import { makeMessage } from './protocol'

const node = (id: string, status: GraphNode['status'] = 'active'): GraphNode => ({
  id,
  label: id,
  type: 'tool',
  status,
})

const link = (id: string): GraphLink => ({ id, source: 'a', target: 'b', type: 'inject' })

describe('applyGraphMessage', () => {
  it('快照整体替换', () => {
    const state = applyGraphMessage(
      initialGraphState,
      makeMessage('graph.snapshot', {
        nodes: [node('a')],
        links: [],
      }),
    )
    expect(state.nodes.map((item) => item.id)).toEqual(['a'])

    const replaced = applyGraphMessage(
      state,
      makeMessage('graph.snapshot', {
        nodes: [node('b')],
        links: [link('l1')],
      }),
    )
    expect(replaced.nodes.map((item) => item.id)).toEqual(['b'])
    expect(replaced.links.map((item) => item.id)).toEqual(['l1'])
  })

  it('upsert 按 id 合并，remove 删除节点与边', () => {
    const base = applyGraphMessage(
      initialGraphState,
      makeMessage('graph.snapshot', {
        nodes: [node('a'), node('b')],
        links: [link('inject:a:b')],
      }),
    )

    const upserted = applyGraphMessage(
      base,
      makeMessage('graph.upsert', {
        nodes: [node('b', 'error'), node('c')],
        links: [],
      }),
    )
    expect(upserted.nodes.map((item) => `${item.id}:${item.status}`)).toEqual([
      'a:active',
      'b:error',
      'c:active',
    ])

    const removed = applyGraphMessage(
      upserted,
      makeMessage('graph.remove', {
        nodeIds: ['b'],
        linkIds: ['inject:a:b'],
      }),
    )
    expect(removed.nodes.map((item) => item.id)).toEqual(['a', 'c'])
    expect(removed.links).toEqual([])
  })

  it('初始状态为空且不可变输入不被改写', () => {
    const snapshot = makeMessage('graph.snapshot', { nodes: [node('a')], links: [] })
    const state = applyGraphMessage(initialGraphState, snapshot)
    expect(initialGraphState.nodes).toEqual([])
    expect(state.nodes).toHaveLength(1)
  })
})
