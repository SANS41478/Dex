import { type Group, Mesh, MeshStandardMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import {
  breathingGlow,
  breathingScale,
  createNodeMeshPool,
  degreeScale,
  emphasisScale,
  statusToken,
  typeToken,
} from './node-shapes'

const node = {
  id: 'a',
  label: 'a',
  type: 'tool' as const,
  status: 'active' as const,
}

describe('类型色 / 尺寸 / 强调', () => {
  it('6 种类型映射到互不相同的视觉 token', () => {
    const tokens = (['model', 'tool', 'skill', 'scheduler', 'sandbox', 'other'] as const).map(
      (type) => typeToken(type),
    )
    expect(new Set(tokens).size).toBe(6)
    expect(typeToken('model')).toBe('--color-data-1')
    expect(typeToken('other')).toBe('--color-text-disabled')
  })

  it('连接度尺寸单调有界；强调尺寸递增', () => {
    expect(degreeScale(0, 10)).toBe(1)
    expect(degreeScale(10, 10)).toBeCloseTo(1.6)
    expect(degreeScale(5, 10)).toBeLessThan(degreeScale(10, 10))
    expect(degreeScale(3, 0)).toBe(1)

    expect(emphasisScale('normal')).toBeLessThan(emphasisScale('hover'))
    expect(emphasisScale('hover')).toBeLessThan(emphasisScale('selected'))
  })

  it('状态只映射到状态 token', () => {
    expect(statusToken('active')).toBe('--color-status-success')
    expect(statusToken('inactive')).toBe('--color-status-pending')
    expect(statusToken('error')).toBe('--color-status-failed')
  })
})

describe('呼吸纯函数', () => {
  it('inactive 完全静止；active / error 随时间变化', () => {
    expect(breathingScale('a', 0, 'inactive')).toBe(1)
    expect(breathingScale('a', 2_800, 'inactive')).toBe(1)

    const activeA = breathingScale('a', 0, 'active')
    const activeB = breathingScale('a', 1_400, 'active')
    expect(activeA).not.toBeCloseTo(activeB)
    expect(activeA).toBeGreaterThanOrEqual(0.98)
    expect(activeA).toBeLessThanOrEqual(1.02)

    const errorA = breathingScale('a', 0, 'error')
    const errorB = breathingScale('a', 800, 'error')
    expect(errorA).not.toBeCloseTo(errorB)
    expect(errorA).toBeGreaterThanOrEqual(0.965)
    expect(errorA).toBeLessThanOrEqual(1.035)
  })

  it('同节点同时间可复现，不同节点相位不同', () => {
    expect(breathingScale('a', 1_000, 'active')).toBe(breathingScale('a', 1_000, 'active'))
    expect(breathingScale('a', 1_000, 'active')).not.toBe(breathingScale('b', 1_000, 'active'))
    expect(breathingGlow('a', 1_000, 'active')).toBeGreaterThan(0)
    expect(breathingGlow('a', 1_000, 'inactive')).toBe(0.14)
  })
})

describe('createNodeMeshPool', () => {
  it('同 id 复用；选中放大；样本可读', () => {
    const pool = createNodeMeshPool()
    const first = pool.obtain(node, 0, 1) as Group
    const second = pool.obtain(node, 0, 1) as Group
    expect(second).toBe(first)
    const mesh = first.children.find((child) => child instanceof Mesh) as Mesh
    expect(mesh.material).toBeInstanceOf(MeshStandardMaterial)
    const normalScale = first.scale.x

    pool.applyEmphasis({ selectedId: 'a', hoveredId: null, neighbors: new Set() })
    expect(first.scale.x).toBeGreaterThan(normalScale)
    expect(pool.sample('a')).toMatchObject({ type: 'tool', status: 'active' })

    pool.prune(new Set())
    const recreated = pool.obtain(node, 0, 1)
    expect(recreated).not.toBe(first)
    pool.dispose()
  })

  it('呼吸帧更新缩放；refreshTheme 不破坏节点', () => {
    const pool = createNodeMeshPool()
    const group = pool.obtain(node, 0, 1) as Group
    const scales = [0, 700, 1_400, 2_100].map((elapsed) => {
      pool.applyBreathing(elapsed)
      return group.scale.x.toFixed(6)
    })
    expect(new Set(scales).size).toBeGreaterThan(1)
    pool.refreshTheme()
    expect(pool.sample('a')?.type).toBe('tool')
    pool.dispose()
  })
})
