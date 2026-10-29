import type { ModelCatalog, ProviderInfo } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { pickDefaultSelection } from './model-default'

function makeProvider(id: string, configured: boolean, models: string[]): ProviderInfo {
  return {
    id,
    name: id,
    models: models.map((model) => ({ id: model, name: model })),
    credential: { configured, writable: true },
  }
}

function makeCatalog(patch: Partial<ModelCatalog>): ModelCatalog {
  return { providers: [], configurable: [], selection: null, defaultSelection: null, ...patch }
}

describe('pickDefaultSelection', () => {
  it('沿用目录里已有的选择（用户上次选过的）', () => {
    const result = pickDefaultSelection(
      makeCatalog({
        providers: [makeProvider('deepseek-official', true, ['deepseek-flash'])],
        selection: { provider: 'rings', model: 'gpt-6-luna' },
      }),
    )

    expect(result).toEqual({ provider: 'rings', model: 'gpt-6-luna' })
  })

  it('没有选择时挑第一个「凭据已配置」的 provider 的首个模型', () => {
    const result = pickDefaultSelection(
      makeCatalog({
        providers: [
          makeProvider('rings', false, ['gpt-6-luna']),
          makeProvider('deepseek-official', true, ['deepseek-flash', 'deepseek-v4-pro']),
        ],
      }),
    )

    expect(result).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('凭据都没配时退回第一个 provider，让流程能走下去', () => {
    const result = pickDefaultSelection(
      makeCatalog({ providers: [makeProvider('rings', false, ['gpt-6-luna'])] }),
    )

    expect(result).toEqual({ provider: 'rings', model: 'gpt-6-luna' })
  })

  it('provider 有凭据但没有模型时不选（不写一个不存在的模型）', () => {
    const result = pickDefaultSelection(
      makeCatalog({ providers: [makeProvider('deepseek-account', true, [])] }),
    )

    expect(result).toBeNull()
  })

  it('没有任何 provider 时返回 null', () => {
    expect(pickDefaultSelection(makeCatalog({}))).toBeNull()
  })
})
