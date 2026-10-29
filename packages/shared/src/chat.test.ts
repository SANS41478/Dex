import { describe, expect, it } from 'vitest'
import { sessionActivateRequestSchema, sessionPromptRequestSchema } from './chat'

describe('sessionActivateRequestSchema', () => {
  it('selection 可省略（新会话与未指定模型的续聊都要能过）', () => {
    const parsed = sessionActivateRequestSchema.parse({
      sessionId: 'dex-1-1',
      workspacePath: 'D:/ws',
    })
    expect(parsed.selection).toBeUndefined()
  })

  it('带上 selection 时按 provider/model 校验', () => {
    const parsed = sessionActivateRequestSchema.parse({
      sessionId: 'dex-1-1',
      workspacePath: 'D:/ws',
      selection: { provider: 'rings', model: 'gpt-6-luna', reasoningEffort: 'medium' },
    })
    expect(parsed.selection).toEqual({
      provider: 'rings',
      model: 'gpt-6-luna',
      reasoningEffort: 'medium',
    })
  })

  it('selection 缺 provider 或 model 一律拒绝', () => {
    for (const selection of [{ provider: 'rings' }, { model: 'gpt-6-luna' }, {}]) {
      expect(
        sessionActivateRequestSchema.safeParse({
          sessionId: 'dex-1-1',
          workspacePath: 'D:/ws',
          selection,
        }).success,
      ).toBe(false)
    }
  })
})

describe('sessionPromptRequestSchema', () => {
  it('空白内容被拒（trim 后为空）', () => {
    expect(
      sessionPromptRequestSchema.safeParse({ sessionId: 'dex-1-1', content: '   ' }).success,
    ).toBe(false)
  })
})
