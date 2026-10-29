import type { SettingsNamespace } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { settingsFields } from './settings-form'

function descriptor(overrides: Partial<SettingsNamespace> = {}): SettingsNamespace {
  return {
    autoGenerate: true,
    ns: 'general',
    schema: {
      uid: 'root',
      refs: {
        root: {
          type: 'object',
          dict: {
            theme: {
              type: 'union',
              meta: { volatile: true },
              list: [
                { type: 'const', value: 'dark' },
                { type: 'const', value: 'light' },
              ],
            },
            enabled: { type: 'boolean', meta: { volatile: true } },
            token: { type: 'string', meta: { volatile: true } },
            custom: { type: 'custom' },
          },
        },
      },
    },
    value: { theme: 'dark', enabled: true, token: '<redacted>', custom: 'opaque' },
    applies: 'live',
    secrets: [{ path: ['token'], set: true }],
    revision: 2,
    ...overrides,
  }
}

describe('settingsFields', () => {
  it('renders supported volatile fields and never exposes secret fields', () => {
    const fields = settingsFields(descriptor())
    expect(fields).toEqual([
      {
        path: ['theme'],
        label: 'theme',
        kind: 'select',
        value: 'dark',
        options: ['dark', 'light'],
      },
      { path: ['enabled'], label: 'enabled', kind: 'boolean', value: true },
      { path: ['custom'], label: 'custom', kind: 'readonly', value: 'opaque' },
    ])
    expect(fields.some((field) => field.label.includes('token'))).toBe(false)
  })

  it('描述里的标量字段即可编辑（回归：dsh 的 describe 已剥离 volatile 标记）', () => {
    // dsh `volatileForm` + `plainSchema` 只保留 volatile 字段并删掉标记；
    // 旧实现按标记判定，把高级页所有字段渲染成只读（2026-10-08 修正）。
    const value = descriptor({
      schema: {
        uid: 'root',
        refs: { root: { type: 'object', dict: { label: { type: 'string' } } } },
      },
      value: { label: 'editable' },
      secrets: [],
    })
    expect(settingsFields(value)).toEqual([
      { path: ['label'], label: 'label', kind: 'string', value: 'editable' },
    ])
  })

  it('解析真实 dsh 形状：根包装 {uid, refs} + 数字 id 引用（2026-10-08 实测回归）', () => {
    const value = descriptor({
      schema: {
        uid: 10514,
        refs: {
          10513: { type: 'boolean', meta: { default: true } },
          10514: { type: 'object', meta: { default: {} }, dict: { enabled: 10513 } },
        },
      },
      value: { enabled: false },
      secrets: [],
    })
    expect(settingsFields(value)).toEqual([
      { path: ['enabled'], label: 'enabled', kind: 'boolean', value: false },
    ])
  })

  it('不可投影为标量的节点（对象/数组值）不产生控件', () => {
    const value = descriptor({
      schema: {
        uid: 'root',
        refs: { root: { type: 'object', dict: { opaque: { type: 'custom' } } } },
      },
      value: { opaque: { deep: true } },
      secrets: [],
    })
    expect(settingsFields(value)).toEqual([])
  })
})
