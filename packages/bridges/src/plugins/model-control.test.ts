import { describe, expect, it } from 'vitest'
import {
  controlRequestSchema,
  controlResponseSchema,
  modelCatalogSchema,
  modelSelectionSchema,
  pluginChangeResultSchema,
  pluginsListSchema,
} from './model-control'

describe('model control contracts', () => {
  it('接受模型目录与选择', () => {
    expect(
      modelCatalogSchema.parse({
        providers: [
          {
            id: 'rings',
            name: 'Rings',
            models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
            credential: { configured: true, writable: true },
          },
        ],
        selection: { provider: 'rings', model: 'gpt-5.6-luna' },
      }).providers[0]?.models[0]?.id,
    ).toBe('gpt-5.6-luna')
    expect(
      modelSelectionSchema.safeParse({ provider: 'rings', model: 'gpt-5.6-luna' }).success,
    ).toBe(true)
  })

  it('拒绝空 provider/model 与未知控制方法', () => {
    expect(modelSelectionSchema.safeParse({ provider: '', model: 'x' }).success).toBe(false)
    expect(
      controlRequestSchema.safeParse({ method: 'models/unknown', requestId: '1' }).success,
    ).toBe(false)
  })

  it('控制响应不携带 secret 字段', () => {
    const response = controlResponseSchema.parse({
      ok: true,
      requestId: '1',
      result: { provider: 'rings', configured: true },
    })
    expect(JSON.stringify(response)).not.toContain('apiKey')
  })

  it('接受会话列表与只读回放请求', () => {
    expect(
      controlRequestSchema.safeParse({ method: 'sessions/list', requestId: '1' }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/replay',
        requestId: '2',
        sessionId: 'session-1',
      }).success,
    ).toBe(true)
  })

  it('接受停止请求，且必须带非空 sessionId', () => {
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/cancel',
        requestId: '3',
        sessionId: 'session-1',
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({ method: 'sessions/cancel', requestId: '3' }).success,
    ).toBe(false)
    expect(
      controlRequestSchema.safeParse({ method: 'sessions/cancel', requestId: '3', sessionId: '' })
        .success,
    ).toBe(false)
  })

  it('接受全局设置描述与 revision 围栏的路径变更请求', () => {
    expect(
      controlRequestSchema.safeParse({ method: 'settings/describe', requestId: 's1' }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'settings/mutate',
        requestId: 's2',
        namespace: 'general',
        operations: [{ op: 'set', path: ['theme'], value: 'light' }],
        expectedRevision: 4,
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'settings/mutate',
        requestId: 's2',
        namespace: 'general',
        operations: [{ op: 'set', path: ['theme'], value: 'light' }],
      }).success,
    ).toBe(false)
  })

  it('接受历史会话恢复请求；selection 可省略，给了就必须合法', () => {
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/resume',
        requestId: '4',
        sessionId: 'h-1',
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/resume',
        requestId: '4',
        sessionId: 'h-1',
        selection: { provider: 'rings', model: 'gpt-5.6-luna' },
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/resume',
        requestId: '4',
        sessionId: 'h-1',
        selection: { provider: 'rings' },
      }).success,
    ).toBe(false)
  })

  it('接受插件清单与启停请求；启停必须带非空 entryId 与布尔 enabled', () => {
    expect(
      controlRequestSchema.safeParse({ method: 'plugins/list', requestId: 'p1' }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'plugins/set-enabled',
        requestId: 'p2',
        entryId: 'include:session-log-deepseek',
        enabled: false,
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'plugins/set-enabled',
        requestId: 'p2',
        entryId: '',
        enabled: false,
      }).success,
    ).toBe(false)
    expect(
      controlRequestSchema.safeParse({
        method: 'plugins/set-enabled',
        requestId: 'p2',
        entryId: 'x',
      }).success,
    ).toBe(false)
  })

  it('插件清单形状：可寻址/只读互斥语义可表达；启停结果的四态可解析', () => {
    const list = pluginsListSchema.parse({
      managementAvailable: true,
      hmrAvailable: true,
      plugins: [
        {
          entryId: 'include:llm-pi-ai',
          moduleName: '@deepseek-ai/dsh-llm-pi-ai',
          enabled: true,
          fiberPhase: 'active',
          patchId: 'llm-pi-ai',
          hasSettings: true,
        },
        {
          entryId: 'include:plugin-manager',
          moduleName: '@deepseek-ai/dsh-plugin-manager',
          enabled: true,
          fiberPhase: 'active',
          readOnlyReason: 'management-required',
          hasSettings: false,
        },
      ],
      bundles: [
        { name: '@deepseek-ai/dsh-base', enabled: true, optional: false, removable: false },
      ],
    })
    expect(list.plugins.map((plugin) => plugin.patchId ?? plugin.readOnlyReason)).toEqual([
      'llm-pi-ai',
      'management-required',
    ])
    expect(
      pluginChangeResultSchema.parse({ changed: true, application: 'overridden' }).application,
    ).toBe('overridden')
    expect(
      pluginChangeResultSchema.safeParse({ changed: true, application: 'unknown' }).success,
    ).toBe(false)
  })

  it('接受消息投递请求；content 必填，mode 只认 followup/steer', () => {
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/prompt',
        requestId: '5',
        sessionId: 'h-1',
        content: '继续',
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/prompt',
        requestId: '5',
        sessionId: 'h-1',
        content: '继续',
        mode: 'steer',
      }).success,
    ).toBe(true)
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/prompt',
        requestId: '5',
        sessionId: 'h-1',
        content: '',
      }).success,
    ).toBe(false)
    expect(
      controlRequestSchema.safeParse({
        method: 'sessions/prompt',
        requestId: '5',
        sessionId: 'h-1',
        content: '继续',
        mode: 'interrupt',
      }).success,
    ).toBe(false)
  })
})
