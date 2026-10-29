import { describe, expect, it } from 'vitest'
import type { DshEventMap, DshEventName, DshEventOptions } from '../dsh/contract'
import { createDexGraphHost, DEX_GRAPH_ROUTE, type DexHostContext } from './entry'

function makeContext(): {
  ctx: DexHostContext
  registrations: { event: string; options: DshEventOptions | undefined }[]
  routes: string[]
  effects: (() => () => unknown)[]
  unregistered: string[]
} {
  const registrations: { event: string; options: DshEventOptions | undefined }[] = []
  const routes: string[] = []
  const effects: (() => () => unknown)[] = []
  const unregistered: string[] = []
  const ctx: DexHostContext = {
    loader: { entries: () => [] },
    webServer: {
      registerUpgrade: (route) => {
        routes.push(route.path)
        return () => {
          unregistered.push(route.path)
        }
      },
    },
    on: <K extends DshEventName>(
      event: K,
      _listener: DshEventMap[K],
      options?: DshEventOptions,
    ) => {
      registrations.push({ event, options })
      return () => true
    },
    effect: (execute) => {
      effects.push(execute)
      return () => {}
    },
  }
  return { ctx, registrations, routes, effects, unregistered }
}

describe('createDexGraphHost', () => {
  it('声明 loader/webServer 依赖并注册升级路由', () => {
    const { ctx, routes } = makeContext()
    const host = createDexGraphHost()
    expect(host.name).toBe('dex-graph-bridge')
    expect(host.inject).toEqual(['loader', 'webServer'])

    host.apply(ctx)
    expect(routes).toEqual([DEX_GRAPH_ROUTE])
  })

  it('以 { global: true } 订阅三类整树事件', () => {
    const { ctx, registrations } = makeContext()
    createDexGraphHost().apply(ctx)

    expect(registrations.map((item) => item.event)).toEqual([
      'loader/entry-init',
      'internal/plugin',
      'internal/status',
    ])
    for (const registration of registrations) {
      expect(registration.options).toEqual({ global: true })
    }
  })

  it('路由路径可配置（端口/路径冲突时便于绕开）', () => {
    const { ctx, routes } = makeContext()
    createDexGraphHost({ routePath: '/custom-graph' }).apply(ctx)
    expect(routes).toEqual(['/custom-graph'])
  })

  it('fiber 卸载时执行清理：注销升级路由 + 取消批处理（dispose 幂等可重入）', () => {
    const { ctx, effects, unregistered } = makeContext()
    createDexGraphHost().apply(ctx)

    expect(effects).toHaveLength(1)
    const dispose = effects[0]?.()
    expect(dispose).toBeTypeOf('function')
    expect(() => dispose?.()).not.toThrow()
    expect(unregistered).toEqual([DEX_GRAPH_ROUTE])
  })
})
