import { describe, expect, it, vi } from 'vitest'
import type { DshFiberRef, DshLoaderEntry } from './contract'
import { DshFiberState } from './contract'
import { createFakeDshHost } from './fake-host'

const entryA: DshLoaderEntry = {
  id: 'entry-a',
  moduleName: 'plugin-a',
  group: false,
  disabled: false,
}

const fiberA: DshFiberRef = { uid: 7, state: DshFiberState.LOADING, inject: { greeter: true } }

describe('fake dsh host', () => {
  it('初始条目可读，initEntry 触发 loader/entry-init', () => {
    const host = createFakeDshHost([entryA])
    const listener = vi.fn()
    host.on('loader/entry-init', listener)

    expect([...host.loader.entries()]).toEqual([entryA])

    host.driver.initEntry({ ...entryA, id: 'entry-b', moduleName: 'plugin-b' })

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'entry-b' }))
    expect([...host.loader.entries()].map((item) => item.id)).toEqual(['entry-a', 'entry-b'])
  })

  it('attachFiber 写入 fiber 并触发 internal/plugin', () => {
    const host = createFakeDshHost([entryA])
    const listener = vi.fn()
    host.on('internal/plugin', listener)

    host.driver.attachFiber('entry-a', fiberA)

    expect(listener).toHaveBeenCalledWith(fiberA)
    expect([...host.loader.entries()][0]?.fiber).toEqual(fiberA)
  })

  it('transition 更新状态并以旧值触发 internal/status', () => {
    const host = createFakeDshHost([entryA])
    host.driver.attachFiber('entry-a', fiberA)
    const listener = vi.fn()
    host.on('internal/status', listener)

    host.driver.transition('entry-a', DshFiberState.ACTIVE)

    expect(listener).toHaveBeenCalledTimes(1)
    const [moved, oldState] = listener.mock.calls[0] ?? []
    expect(oldState).toBe(DshFiberState.LOADING)
    expect(moved.state).toBe(DshFiberState.ACTIVE)
    expect([...host.loader.entries()][0]?.fiber?.state).toBe(DshFiberState.ACTIVE)
  })

  it('detachFiber 以 uid=null、DISPOSED 触发 internal/plugin 并移除 fiber', () => {
    const host = createFakeDshHost([entryA])
    host.driver.attachFiber('entry-a', fiberA)
    const listener = vi.fn()
    host.on('internal/plugin', listener)

    host.driver.detachFiber('entry-a')

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ uid: null, state: DshFiberState.DISPOSED }),
    )
    const stored = [...host.loader.entries()][0]
    expect(stored?.id).toBe('entry-a')
    expect(stored?.moduleName).toBe('plugin-a')
    expect(stored?.fiber).toBeUndefined()
  })

  it('撤订函数生效且可重复调用', () => {
    const host = createFakeDshHost()
    const listener = vi.fn()
    const off = host.on('loader/entry-init', listener)

    expect(off()).toBe(true)
    expect(off()).toBe(false)

    host.driver.initEntry(entryA)
    expect(listener).not.toHaveBeenCalled()
  })

  it('disposeAll 等价 fiber 卸载，清空全部订阅', () => {
    const host = createFakeDshHost([entryA])
    const listener = vi.fn()
    host.on('internal/plugin', listener)

    host.driver.disposeAll()
    host.driver.attachFiber('entry-a', fiberA)

    expect(listener).not.toHaveBeenCalled()
  })

  it('对未知条目操作会抛错（防止测试静默漂移）', () => {
    const host = createFakeDshHost()
    expect(() => host.driver.attachFiber('missing', fiberA)).toThrow('unknown entry: missing')
    expect(() => host.driver.transition('missing', DshFiberState.ACTIVE)).toThrow(
      'unknown entry: missing',
    )
  })
})
