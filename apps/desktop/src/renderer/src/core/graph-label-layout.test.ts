import { describe, expect, it } from 'vitest'
import { layoutGraphLabels } from './graph-label-layout'

describe('layoutGraphLabels', () => {
  it('重叠标签只保留第一个，force 标签始终保留', () => {
    const result = layoutGraphLabels(
      [
        { id: 'a', x: 100, y: 100, label: 'alpha' },
        { id: 'b', x: 104, y: 102, label: 'beta' },
        { id: 'c', x: 108, y: 104, label: 'selected', force: true },
      ],
      400,
      300,
    )
    expect(result.map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('按容器边界夹紧，空尺寸返回空数组', () => {
    const result = layoutGraphLabels([{ id: 'a', x: -50, y: 500, label: 'x' }], 300, 200)
    expect(result[0]?.x).toBeGreaterThan(0)
    expect(result[0]?.y).toBeLessThan(200)
    expect(layoutGraphLabels([{ id: 'a', x: 1, y: 1, label: 'x' }], 0, 0)).toEqual([])
  })
})
