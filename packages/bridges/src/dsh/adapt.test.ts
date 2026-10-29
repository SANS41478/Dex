import { describe, expect, it } from 'vitest'
import { adaptEntries, adaptEntry, adaptFiber, type DshRawEntry, extractConfigKeys } from './adapt'
import { DshFiberState } from './contract'

describe('adaptFiber', () => {
  it('把 Impl 投影为提供方 uid', () => {
    const fiber = adaptFiber({
      uid: 3,
      state: DshFiberState.ACTIVE,
      inject: { greeter: true },
      store: { greeter: { fiber: { uid: 7 } }, loader: {} },
    })
    expect(fiber).toEqual({
      uid: 3,
      state: DshFiberState.ACTIVE,
      inject: { greeter: true },
      store: { greeter: 7, loader: null },
    })
  })

  it('无 store / 无 inject 时只投影声明字段', () => {
    expect(adaptFiber({ uid: null, state: DshFiberState.DISPOSED })).toEqual({
      uid: null,
      state: DshFiberState.DISPOSED,
      inject: {},
    })
  })
})

describe('adaptEntry', () => {
  it('读取 options.name / options.group / disabled 与 fiber', () => {
    const raw: DshRawEntry = {
      id: 'tool-fs',
      options: { name: '@deepseek-ai/dsh-tool-fs', group: false },
      disabled: false,
      fiber: { uid: 1, state: DshFiberState.ACTIVE, store: { sandbox: { fiber: { uid: 2 } } } },
    }
    expect(adaptEntry(raw)).toEqual({
      id: 'tool-fs',
      moduleName: '@deepseek-ai/dsh-tool-fs',
      group: false,
      disabled: false,
      fiber: {
        uid: 1,
        state: DshFiberState.ACTIVE,
        inject: {},
        store: { sandbox: 2 },
      },
    })
  })

  it('内建行缺 options.name 时不产生空字段；分组行标记 group', () => {
    expect(adaptEntry({ id: 'include' })).toEqual({ id: 'include', group: false, disabled: false })
    expect(adaptEntry({ id: 'group-a', options: { group: true } }).group).toBe(true)
  })

  it('只提取非敏感配置键名，不返回配置值', () => {
    expect(
      extractConfigKeys({
        retries: 2,
        apiKey: 'secret',
        token: 'secret',
        workspacePath: 'C:/secret',
        mode: 'safe',
      }),
    ).toEqual({ readable: true, keys: ['mode', 'retries'] })
    expect(extractConfigKeys(undefined)).toEqual({ readable: false, keys: [] })
  })

  it('配置对象从 loader entry 投影为只读元数据', () => {
    const entry = adaptEntry({
      id: 'tool-fs',
      options: {
        name: '@deepseek-ai/dsh-tool-fs',
        config: { mode: 'workspace-write', apiKey: 'secret' },
      },
    })
    expect(entry).toMatchObject({
      configReadable: true,
      configKeys: ['mode'],
    })
    expect(JSON.stringify(entry)).not.toContain('secret')
  })

  it('adaptEntries 过滤不了非对象但会按字段兜底', () => {
    const list = adaptEntries([{ id: 'a', options: { name: 'm' } }, { id: 'b' }])
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(list[0]?.moduleName).toBe('m')
    expect(list[1]?.moduleName).toBeUndefined()
  })
})
