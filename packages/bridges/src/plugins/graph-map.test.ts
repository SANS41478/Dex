import { describe, expect, it } from 'vitest'
import type { DshFiberRef, DshFiberStateValue, DshLoaderEntry } from '../dsh/contract'
import { DshFiberState } from '../dsh/contract'
import {
  buildGraph,
  entryToNode,
  inferPluginType,
  injectLinkId,
  toNodeLabel,
  toNodeStatus,
} from './graph-map'

function makeFiber(
  state: DshFiberStateValue,
  options: { uid?: number | null; store?: Record<string, number | null> } = {},
): DshFiberRef {
  const ref: DshFiberRef = {
    uid: options.uid === undefined ? 1 : options.uid,
    state,
    inject: {},
  }
  return options.store === undefined ? ref : { ...ref, store: options.store }
}

function makeEntry(id: string, overrides: Partial<DshLoaderEntry> = {}): DshLoaderEntry {
  return {
    id,
    moduleName: `@deepseek-ai/dsh-${id}`,
    group: false,
    disabled: false,
    ...overrides,
  }
}

describe('inferPluginType', () => {
  it.each([
    ['@deepseek-ai/dsh-tool-fs', 'tool'],
    ['@deepseek-ai/dsh-tool-skill', 'tool'],
    ['@deepseek-ai/dsh-model-deepseek', 'model'],
    ['@deepseek-ai/dsh-model-adapter-openai', 'model'],
    ['@deepseek-ai/dsh-llm-pi-ai', 'model'],
    ['@deepseek-ai/dsh-skill-filesystem', 'skill'],
    ['@deepseek-ai/dsh-scheduler-cron', 'scheduler'],
    ['@deepseek-ai/cordis-plugin-timer', 'scheduler'],
    ['@deepseek-ai/dsh-sandbox-local', 'sandbox'],
    ['@deepseek-ai/dsh-host-plugin-inventory', 'other'],
    ['./local-plugin.ts', 'other'],
    ['PluginWithTOOL', 'tool'],
  ])('%s → %s', (moduleName, expected) => {
    expect(inferPluginType(moduleName)).toBe(expected)
  })

  it('缺 moduleName（内建行）归入兜底类型 other', () => {
    expect(inferPluginType(undefined)).toBe('other')
    expect(inferPluginType('')).toBe('other')
  })
})

describe('toNodeLabel', () => {
  it('去 scope 保留包名', () => {
    expect(toNodeLabel('@deepseek-ai/dsh-tool-fs')).toBe('dsh-tool-fs')
  })

  it('非 scoped 模块名原样保留', () => {
    expect(toNodeLabel('./local-plugin.ts')).toBe('./local-plugin.ts')
  })

  it('内建行缺 moduleName 时返回 null（由条目 id 兜底）', () => {
    expect(toNodeLabel(undefined)).toBeNull()
    expect(toNodeLabel('')).toBeNull()
  })
})

describe('toNodeStatus', () => {
  it.each([
    [DshFiberState.ACTIVE, 'active'],
    [DshFiberState.FAILED, 'error'],
    [DshFiberState.PENDING, 'inactive'],
    [DshFiberState.LOADING, 'inactive'],
    [DshFiberState.UNLOADING, 'inactive'],
    [DshFiberState.DISPOSED, 'inactive'],
  ])('相位 %s → %s', (state, expected) => {
    expect(toNodeStatus(makeEntry('a', { fiber: makeFiber(state) }))).toBe(expected)
  })

  it('无 fiber、uid=null、disabled 都视为 inactive', () => {
    expect(toNodeStatus(makeEntry('a'))).toBe('inactive')
    expect(
      toNodeStatus(makeEntry('a', { fiber: makeFiber(DshFiberState.ACTIVE, { uid: null }) })),
    ).toBe('inactive')
    expect(
      toNodeStatus(makeEntry('a', { disabled: true, fiber: makeFiber(DshFiberState.ACTIVE) })),
    ).toBe('inactive')
  })
})

describe('entryToNode', () => {
  it('分组条目返回 null', () => {
    expect(entryToNode(makeEntry('g', { group: true }))).toBeNull()
  })

  it('普通条目映射为节点（含完整模块名）', () => {
    expect(entryToNode(makeEntry('tool-fs', { fiber: makeFiber(DshFiberState.ACTIVE) }))).toEqual({
      id: 'tool-fs',
      label: 'dsh-tool-fs',
      type: 'tool',
      status: 'active',
      disabled: false,
      controlCapabilities: { canEnable: false, canDisable: false, canConfigure: false },
      moduleName: '@deepseek-ai/dsh-tool-fs',
    })
  })

  it('缺模块名的内建行以条目 id 作 label', () => {
    expect(
      entryToNode({
        id: 'include',
        group: false,
        disabled: false,
        fiber: makeFiber(DshFiberState.ACTIVE),
      }),
    ).toEqual({
      id: 'include',
      label: 'include',
      type: 'other',
      status: 'active',
      disabled: false,
      controlCapabilities: { canEnable: false, canDisable: false, canConfigure: false },
    })
  })
})

describe('buildGraph', () => {
  const provider = makeEntry('sandbox-local', {
    fiber: makeFiber(DshFiberState.ACTIVE, { uid: 7 }),
  })
  const consumer = makeEntry('tool-fs', {
    fiber: makeFiber(DshFiberState.ACTIVE, { uid: 8, store: { 'sandbox-local': 7 } }),
  })

  it('由 store 反查提供方条目生成 inject 边', () => {
    const graph = buildGraph([provider, consumer])
    expect(graph.links).toEqual([
      {
        id: injectLinkId('tool-fs', 'sandbox-local'),
        source: 'tool-fs',
        target: 'sandbox-local',
        type: 'inject',
      },
    ])
  })

  it('无法定位的提供方（根服务 / 树外 fiber / 自环）不产生边', () => {
    const rootService = makeEntry('a', {
      fiber: makeFiber(DshFiberState.ACTIVE, { uid: 1, store: { loader: null, missing: 999 } }),
    })
    const selfLoop = makeEntry('b', {
      fiber: makeFiber(DshFiberState.ACTIVE, { uid: 2, store: { b: 2 } }),
    })
    const graph = buildGraph([rootService, selfLoop])
    expect(graph.links).toEqual([])
  })

  it('分组条目既不出节点也不参与边反查', () => {
    const group = makeEntry('group', {
      group: true,
      fiber: makeFiber(DshFiberState.ACTIVE, { uid: 7 }),
    })
    const graph = buildGraph([group, consumer])
    expect(graph.nodes.map((node) => node.id)).toEqual(['tool-fs'])
    expect(graph.links).toEqual([])
  })

  it('未解析依赖（无 store）不产生边', () => {
    const loading = makeEntry('tool-fs', { fiber: makeFiber(DshFiberState.LOADING, { uid: 8 }) })
    const graph = buildGraph([provider, loading])
    expect(graph.links).toEqual([])
  })
})
