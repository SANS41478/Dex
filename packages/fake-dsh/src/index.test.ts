import { parseEnvelope } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { buildDemoGraphTurn, buildDemoTurn, createDemoGraphSnapshot } from './index'

describe('buildDemoTurn', () => {
  it('每条消息都通过协议校验', () => {
    for (const turnIndex of [0, 1]) {
      for (const event of buildDemoTurn(turnIndex)) {
        const result = parseEnvelope(JSON.parse(JSON.stringify(event.message)))
        expect(result.ok, `turn ${turnIndex} 的消息 ${event.message.type} 应通过校验`).toBe(true)
      }
    }
  })

  it('事件顺序符合 turn → step → tool 结构', () => {
    const types = buildDemoTurn(0).map((event) => event.message.type)
    expect(types[0]).toBe('trace.turn.start')
    expect(types.at(-1)).toBe('trace.turn.end')
    expect(types).toContain('trace.tool.start')
    expect(types.indexOf('trace.step.start')).toBeLessThan(types.indexOf('trace.step.end'))
  })

  it('偶数轮全部成功、奇数轮含失败工具调用', () => {
    const firstTurnFailed = buildDemoTurn(0).some(
      (event) =>
        event.message.type === 'trace.tool.end' && event.message.payload.status === 'failed',
    )
    const secondTurnFailed = buildDemoTurn(1).some(
      (event) =>
        event.message.type === 'trace.tool.end' && event.message.payload.status === 'failed',
    )
    expect(firstTurnFailed).toBe(false)
    expect(secondTurnFailed).toBe(true)
  })
})

describe('demo graph', () => {
  it('快照通过协议校验，覆盖全部插件类型且边只引用快照内节点', () => {
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(createDemoGraphSnapshot())))
    if (!parsed.ok) throw new Error('invalid snapshot')
    if (parsed.message.type !== 'graph.snapshot') throw new Error('expected graph.snapshot')

    const { nodes, links } = parsed.message.payload
    expect(new Set(nodes.map((node) => node.type))).toEqual(
      new Set(['model', 'tool', 'skill', 'scheduler', 'sandbox', 'other']),
    )
    const nodeIds = new Set(nodes.map((node) => node.id))
    for (const link of links) {
      expect(nodeIds.has(link.source), `${link.id} 的 source 应存在于快照`).toBe(true)
      expect(nodeIds.has(link.target), `${link.id} 的 target 应存在于快照`).toBe(true)
    }
    expect(links.length).toBeGreaterThan(0)
  })

  it('偶数轮 upsert 生长、奇数轮 remove 回缩，且都通过协议校验', () => {
    const grow = buildDemoGraphTurn(0)
    const shrink = buildDemoGraphTurn(1)

    expect(grow[0]?.message.type).toBe('graph.upsert')
    expect(shrink[0]?.message.type).toBe('graph.remove')

    const lifecycle = [...grow, ...shrink]
    for (const event of lifecycle) {
      expect(parseEnvelope(JSON.parse(JSON.stringify(event.message))).ok).toBe(true)
    }

    const removed = shrink[0]?.message
    if (removed?.type !== 'graph.remove') throw new Error('expected graph.remove')
    const added = grow[0]?.message
    if (added?.type !== 'graph.upsert') throw new Error('expected graph.upsert')
    expect(removed.payload.nodeIds).toEqual(added.payload.nodes.map((node) => node.id))
  })
})
