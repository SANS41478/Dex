import { describe, expect, it } from 'vitest'
import {
  isReasoningEffortSupported,
  reasoningEfforts,
  reasoningEffortsFor,
  resolveReasoningEffort,
} from './reasoning'

describe('reasoning effort 能力表', () => {
  it('已知不支持的 provider 路由只保留 off（deepseek-official 两个模型都拒绝 medium）', () => {
    expect(reasoningEffortsFor('deepseek-official', 'deepseek-flash')).toEqual(['off'])
    expect(reasoningEffortsFor('deepseek-official', 'deepseek-v4-pro')).toEqual(['off'])
    expect(isReasoningEffortSupported('deepseek-official', 'deepseek-flash', 'medium')).toBe(false)
    expect(isReasoningEffortSupported('deepseek-official', 'deepseek-v4-pro', 'medium')).toBe(false)
    expect(isReasoningEffortSupported('deepseek-official', 'deepseek-flash', 'off')).toBe(true)
  })

  it('未知 provider/model 视为全档位可用，不擅自降级', () => {
    expect(reasoningEffortsFor('rings', 'gpt-6-luna')).toEqual(reasoningEfforts)
    expect(reasoningEffortsFor(undefined, undefined)).toEqual(reasoningEfforts)
  })
})

describe('resolveReasoningEffort', () => {
  it('能原样用就原样用', () => {
    expect(resolveReasoningEffort('deepseek-official', 'deepseek-flash', 'off')).toBe('off')
    expect(resolveReasoningEffort('rings', 'gpt-6-luna', 'high')).toBe('high')
  })

  it('不支持时回落到不高于该档位的最高可用档（D01 的默认组合）', () => {
    // 默认 medium + 默认模型 deepseek-flash 过去必炸 UNSUPPORTED_REASONING_EFFORT。
    expect(resolveReasoningEffort('deepseek-official', 'deepseek-flash', 'medium')).toBe('off')
    expect(resolveReasoningEffort('deepseek-official', 'deepseek-v4-pro', 'medium')).toBe('off')
    expect(resolveReasoningEffort('deepseek-official', 'deepseek-flash', 'high')).toBe('off')
    expect(resolveReasoningEffort('deepseek-official', 'deepseek-flash', 'off')).toBe('off')
  })

  it('模型选择还没落地时也不炸', () => {
    expect(resolveReasoningEffort(undefined, undefined, 'medium')).toBe('medium')
  })
})
