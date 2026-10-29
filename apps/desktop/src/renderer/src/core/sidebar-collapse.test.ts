import { describe, expect, it } from 'vitest'
import { parseCollapsedIds, serializeCollapsedIds, toggleCollapsedId } from './sidebar-collapse'

describe('parseCollapsedIds', () => {
  it('空输入返回空表', () => {
    expect(parseCollapsedIds(null)).toEqual([])
    expect(parseCollapsedIds('')).toEqual([])
  })

  it('坏 JSON 与非字符串数组都视为空表，不抛错', () => {
    expect(parseCollapsedIds('{not json')).toEqual([])
    expect(parseCollapsedIds('{"a":1}')).toEqual([])
    expect(parseCollapsedIds('[1,2,3]')).toEqual([])
  })

  it('过滤掉空串，保留有效 id', () => {
    expect(parseCollapsedIds('["a","","b"]')).toEqual(['a', 'b'])
  })
})

describe('toggleCollapsedId', () => {
  it('幂等：折了展开、展开再折', () => {
    expect(toggleCollapsedId(['a'], 'a')).toEqual([])
    expect(toggleCollapsedId([], 'a')).toEqual(['a'])
  })

  it('不改入参（zustand set 依赖不可变性）', () => {
    const before = ['a', 'b']
    toggleCollapsedId(before, 'c')
    expect(before).toEqual(['a', 'b'])
  })
})

describe('serializeCollapsedIds', () => {
  it('与 parse 往返一致', () => {
    const ids = ['workspace:e:/dexagent', 'workspace:d:/ws']
    expect(parseCollapsedIds(serializeCollapsedIds(ids))).toEqual(ids)
  })
})
