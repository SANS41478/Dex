import { describe, expect, it } from 'vitest'
import { createColorResolver } from './color'

const identityProbe = (css: string): string | null => (css.startsWith('oklch') ? '#123456' : null)

describe('createColorResolver', () => {
  it('用探针解析并缓存结果', () => {
    const calls: string[] = []
    const resolve = createColorResolver((css) => {
      calls.push(css)
      return identityProbe(css)
    })

    expect(resolve('oklch(0.74 0.16 150)')).toBe('#123456')
    expect(resolve('oklch(0.74 0.16 150)')).toBe('#123456')
    expect(calls).toHaveLength(1)
  })

  it('探针失败时回退原值（不抛异常）', () => {
    const resolve = createColorResolver(() => null)
    expect(resolve('#abcdef')).toBe('#abcdef')
    expect(resolve('')).toBe('')
  })
})
