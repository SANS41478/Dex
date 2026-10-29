import { describe, expect, it } from 'vitest'
import type {
  ProjectionChangeListenerLike,
  ProjectionDefinitionLike,
  SessionLike,
} from '../dsh/session'
import { TRACE_PROJECTION_KEY } from '../plugins/trace-projection'
import { createDexTraceHost, DEX_TRACE_ROUTE, type DexTraceContext } from './trace-entry'

function makeContext(): {
  ctx: DexTraceContext
  routes: string[]
  definitions: ProjectionDefinitionLike<unknown>[]
  listeners: ProjectionChangeListenerLike[]
  effects: (() => () => unknown)[]
  unregistered: string[]
  disposed: { projection: number; listener: number }
} {
  const routes: string[] = []
  const definitions: ProjectionDefinitionLike<unknown>[] = []
  const listeners: ProjectionChangeListenerLike[] = []
  const effects: (() => () => unknown)[] = []
  const unregistered: string[] = []
  const disposed = { projection: 0, listener: 0 }
  const session: SessionLike = { id: 'sess-1', append: () => undefined }
  const ctx: DexTraceContext = {
    loader: {
      entries: () => [{ id: 'entry-fs', options: { name: '@deepseek-ai/dsh-tool-fs' } }],
    },
    webServer: {
      registerUpgrade: (route) => {
        routes.push(route.path)
        return () => {
          unregistered.push(route.path)
        }
      },
    },
    sessions: {
      create: () => session,
      list: () => [session],
    },
    sessionProjections: {
      register: (definition) => {
        definitions.push(definition as ProjectionDefinitionLike<unknown>)
        return () => {
          disposed.projection += 1
        }
      },
      stateOf: () => ({ sessionId: 'sess-1', turns: [], activeStepId: null }),
      onChanged: (listener) => {
        listeners.push(listener)
        return () => {
          disposed.listener += 1
        }
      },
    },
    effect: (execute) => {
      effects.push(execute)
      return () => {}
    },
  }
  return { ctx, routes, definitions, listeners, effects, unregistered, disposed }
}

describe('createDexTraceHost', () => {
  it('声明四项依赖、注册带 wire 的投影与 /dex-trace 路由、订阅变更流', () => {
    const { ctx, routes, definitions, listeners } = makeContext()
    const host = createDexTraceHost({ log: () => {} })
    expect(host.name).toBe('dex-trace-bridge')
    expect(host.inject).toEqual(['loader', 'webServer', 'sessionProjections', 'sessions'])

    host.apply(ctx)

    expect(routes).toEqual([DEX_TRACE_ROUTE])
    const definition = definitions[0]
    expect(definition?.key).toBe(TRACE_PROJECTION_KEY)
    expect(definition?.stateVersion).toBe(4)
    // wire 是 onChanged 的前提（host-only 单元不进入变更流）
    expect(definition?.wire).toBeDefined()
    expect(listeners).toHaveLength(1)
  })

  it('变更流：无关 key / 非法状态不抛异常，合法状态正常进入桥', () => {
    const { ctx, listeners } = makeContext()
    createDexTraceHost({ log: () => {} }).apply(ctx)
    const listener = listeners[0]
    if (listener === undefined) throw new Error('expected listener')
    const session: SessionLike = { id: 'sess-1', append: () => undefined }

    expect(() => listener(session, 'otherKey', {}, 1)).not.toThrow()
    expect(() => listener(session, TRACE_PROJECTION_KEY, { turns: 'bad' }, 2)).not.toThrow()
    expect(() =>
      listener(
        session,
        TRACE_PROJECTION_KEY,
        { sessionId: 'sess-1', turns: [], activeStepId: null },
        3,
      ),
    ).not.toThrow()
  })

  it('路由路径可配置', () => {
    const { ctx, routes } = makeContext()
    createDexTraceHost({ routePath: '/custom-trace', log: () => {} }).apply(ctx)
    expect(routes).toEqual(['/custom-trace'])
  })

  it('fiber 卸载时清理：注销路由、退订变更流、注销投影', () => {
    const { ctx, effects, unregistered, disposed } = makeContext()
    createDexTraceHost({ log: () => {} }).apply(ctx)

    expect(effects).toHaveLength(1)
    const dispose = effects[0]?.()
    expect(dispose).toBeTypeOf('function')
    expect(() => dispose?.()).not.toThrow()
    expect(unregistered).toEqual([DEX_TRACE_ROUTE])
    expect(disposed).toEqual({ projection: 1, listener: 1 })
  })
})
