import { describe, expect, it } from 'vitest'
import {
  parseOrderMap,
  reconcileManualOrder,
  reorderSession,
  serializeOrderMap,
  withSessionOrder,
} from './sidebar-order'

const summaries = {
  a: { updatedAt: 10 },
  b: { updatedAt: 30 },
  c: { updatedAt: 20 },
  d: { updatedAt: 20 },
}

describe('parseOrderMap', () => {
  it('空输入 / 坏 JSON / 非对象都视为空表，不抛错', () => {
    expect(parseOrderMap(null)).toEqual({})
    expect(parseOrderMap('')).toEqual({})
    expect(parseOrderMap('{not json')).toEqual({})
    expect(parseOrderMap('[1,2,3]')).toEqual({})
  })

  it('过滤非数组值、空串 id 与空数组账号', () => {
    expect(parseOrderMap('{"w":["x","","y"],"bad":"no","empty":[]}')).toEqual({ w: ['x', 'y'] })
  })

  it('与 serialize 往返一致', () => {
    const map = { 'workspace:e:/repo': ['s1', 's2'], __ungrouped__: ['s3'] }
    expect(parseOrderMap(serializeOrderMap(map))).toEqual(map)
  })
})

describe('withSessionOrder', () => {
  it('写入、覆盖、空数组即删除，且不改入参', () => {
    const before = { w: ['s1'] }
    expect(withSessionOrder(before, 'w', ['s2', 's1'])).toEqual({ w: ['s2', 's1'] })
    expect(withSessionOrder(before, 'other', ['s3'])).toEqual({ w: ['s1'], other: ['s3'] })
    expect(withSessionOrder(before, 'w', [])).toEqual({})
    expect(before).toEqual({ w: ['s1'] })
  })
})

describe('reconcileManualOrder', () => {
  it('保存顺序优先：仍存在的成员保序，未知 id 与重复项被丢弃', () => {
    expect(
      reconcileManualOrder({
        memberIds: ['a', 'b', 'c'],
        savedOrder: ['c', 'ghost', 'a', 'c'],
        summaries,
        pinnedIds: [],
      }),
    ).toEqual(['c', 'a', 'b'])
  })

  it('新成员按最近使用补位（同刻按 id 升序决胜）', () => {
    expect(
      reconcileManualOrder({
        memberIds: ['a', 'b', 'c', 'd'],
        savedOrder: ['a'],
        summaries,
        pinnedIds: [],
      }),
    ).toEqual(['a', 'b', 'c', 'd'])
  })

  it('未入保存顺序的置顶成员插到最前；已在保存顺序里的置顶成员保持原位（dsh 语义）', () => {
    expect(
      reconcileManualOrder({
        memberIds: ['a', 'b', 'c'],
        savedOrder: ['a'],
        summaries,
        pinnedIds: ['a', 'c'],
      }),
    ).toEqual(['c', 'a', 'b'])
  })

  it('缺 summary 的置顶成员被略过；无保存顺序时全部按最近使用', () => {
    expect(
      reconcileManualOrder({
        memberIds: ['a', 'b', 'ghost'],
        savedOrder: undefined,
        summaries,
        pinnedIds: ['ghost', 'b'],
      }),
    ).toEqual(['b', 'a'])
  })
})

describe('reorderSession', () => {
  const order = ['a', 'b', 'c', 'd']

  it('摘出 source 插到 target 前 / 后', () => {
    expect(reorderSession({ order, sourceId: 'd', targetId: 'b', half: 'before' })).toEqual([
      'a',
      'd',
      'b',
      'c',
    ])
    expect(reorderSession({ order, sourceId: 'a', targetId: 'c', half: 'after' })).toEqual([
      'b',
      'c',
      'a',
      'd',
    ])
  })

  it('非法输入与原地不动返回 null', () => {
    expect(reorderSession({ order, sourceId: 'a', targetId: 'a', half: 'before' })).toBeNull()
    expect(reorderSession({ order, sourceId: 'ghost', targetId: 'a', half: 'before' })).toBeNull()
    expect(reorderSession({ order, sourceId: 'a', targetId: 'ghost', half: 'before' })).toBeNull()
    expect(reorderSession({ order, sourceId: 'a', targetId: 'b', half: 'before' })).toBeNull()
    expect(reorderSession({ order, sourceId: 'b', targetId: 'a', half: 'after' })).toBeNull()
  })

  it('不改入参', () => {
    const before = ['a', 'b', 'c']
    reorderSession({ order: before, sourceId: 'c', targetId: 'a', half: 'before' })
    expect(before).toEqual(['a', 'b', 'c'])
  })
})
