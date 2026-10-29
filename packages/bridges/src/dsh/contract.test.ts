import { describe, expect, it } from 'vitest'
import { DshFiberState, toFiberPhase } from './contract'

describe('dsh contract', () => {
  it('FiberState 数值镜像与 cordis 对齐（改序会静默弄坏全部状态判断）', () => {
    expect(DshFiberState).toEqual({
      PENDING: 0,
      LOADING: 1,
      ACTIVE: 2,
      FAILED: 3,
      DISPOSED: 4,
      UNLOADING: 5,
    })
  })

  it('toFiberPhase 覆盖全部状态且 DISPOSED → null', () => {
    expect(toFiberPhase(DshFiberState.PENDING)).toBe('pending')
    expect(toFiberPhase(DshFiberState.LOADING)).toBe('loading')
    expect(toFiberPhase(DshFiberState.ACTIVE)).toBe('active')
    expect(toFiberPhase(DshFiberState.FAILED)).toBe('failed')
    expect(toFiberPhase(DshFiberState.UNLOADING)).toBe('unloading')
    expect(toFiberPhase(DshFiberState.DISPOSED)).toBeNull()
  })
})
