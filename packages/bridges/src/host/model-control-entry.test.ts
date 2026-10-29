import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleRowOf,
  isSessionArtifactName,
  localizedText,
  pluginFailureOf,
  pluginRowOf,
  pluginSettingsNamespace,
  profileModuleCandidates,
  removeSessionArtifactFiles,
} from './model-control-entry'

const TAIL = ['@deepseek-ai', 'dsh-llm', 'lib', 'index.js'] as const

const originalProfile = process.env.DEX_DSH_PROFILE
afterEach(() => {
  if (originalProfile === undefined) delete process.env.DEX_DSH_PROFILE
  else process.env.DEX_DSH_PROFILE = originalProfile
})

/**
 * 回归：dsh 0.2 起 profile 布局由「`profiles/node_modules` 共享池」改为
 * 「`profiles/<name>/node_modules`」。兜底路径原先写死前者，导致 `~/.dex-dsh`
 * 下必然落空，症状是发消息时报「dsh 消息构造能力不可用（@deepseek-ai/dsh-llm 未能载入）」。
 */
describe('profileModuleCandidates · dsh profile 布局', () => {
  it('把「profile 自己的 node_modules」排在第一位', () => {
    const home = mkdtempSync(join(tmpdir(), 'dex-profile-'))
    mkdirSync(join(home, 'profiles', 'dex'), { recursive: true })

    const candidates = profileModuleCandidates(home, TAIL)

    expect(candidates[0]).toBe(join(home, 'profiles', 'dex', 'node_modules', ...TAIL))
  })

  it('历史共享池 `profiles/node_modules` 仍在候选里、且排最后（dsh 0.1 布局兜底）', () => {
    const home = mkdtempSync(join(tmpdir(), 'dex-profile-'))
    mkdirSync(join(home, 'profiles', 'dex'), { recursive: true })

    const candidates = profileModuleCandidates(home, TAIL)

    expect(candidates.at(-1)).toBe(join(home, 'profiles', 'node_modules', ...TAIL))
  })

  it('DEX_DSH_PROFILE 可改写指定 profile，其他 profile 作为后备一起进候选', () => {
    const home = mkdtempSync(join(tmpdir(), 'dex-profile-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    process.env.DEX_DSH_PROFILE = 'web'

    const candidates = profileModuleCandidates(home, TAIL)

    expect(candidates[0]).toBe(join(home, 'profiles', 'web', 'node_modules', ...TAIL))
    expect(candidates).toContain(join(home, 'profiles', 'desktop', 'node_modules', ...TAIL))
  })

  it('profiles 目录不存在时不抛错，仍给出显式 profile 与共享池两条候选', () => {
    const home = join(tmpdir(), `dex-profile-absent-${Date.now()}-${Math.random()}`)

    const candidates = profileModuleCandidates(home, TAIL)

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toBe(join(home, 'profiles', 'dex', 'node_modules', ...TAIL))
    expect(candidates[1]).toBe(join(home, 'profiles', 'node_modules', ...TAIL))
  })
})

describe('pluginRowOf（UI-10 行映射）', () => {
  it('映射上游 listPlugins 行：可寻址行带 patchId，设置命名空间按行 id 命中', () => {
    const row = pluginRowOf(
      {
        entryId: 'include:llm-pi-ai',
        moduleName: '@deepseek-ai/dsh-llm-pi-ai',
        enabled: true,
        fiberPhase: 'active',
        patchId: 'llm-pi-ai',
        meta: { title: { en: 'Rings provider' }, description: 'OpenAI-compatible' },
      },
      new Set(['llm-pi-ai']),
    )
    expect(row).toEqual({
      entryId: 'include:llm-pi-ai',
      moduleName: '@deepseek-ai/dsh-llm-pi-ai',
      enabled: true,
      fiberPhase: 'active',
      patchId: 'llm-pi-ai',
      hasSettings: true,
      title: 'Rings provider',
      description: 'OpenAI-compatible',
    })
  })

  it('管理保护和不可寻址行如实透传 readOnlyReason；缺字段的坏行返回 null', () => {
    expect(
      pluginRowOf(
        {
          entryId: 'include:plugin-manager',
          moduleName: '@deepseek-ai/dsh-plugin-manager',
          enabled: true,
          fiberPhase: 'active',
          readOnlyReason: 'management-required',
        },
        new Set(),
      )?.readOnlyReason,
    ).toBe('management-required')
    expect(pluginRowOf({ entryId: 'x' }, new Set())).toBeNull()
    expect(pluginRowOf(null, new Set())).toBeNull()
  })

  it('pluginSettingsNamespace 兼容 include: 前缀与嵌套尾段', () => {
    expect(pluginSettingsNamespace('include:hmr', new Set(['hmr']))).toBe(true)
    expect(pluginSettingsNamespace('group:include:pwsh-sandbox', new Set(['pwsh-sandbox']))).toBe(
      true,
    )
    expect(pluginSettingsNamespace('include:dex-graph-bridge', new Set(['hmr']))).toBe(false)
  })
})

describe('bundleRowOf / localizedText / pluginFailureOf', () => {
  it('bundle 行：meta 描述优先，错误码透传，row 缺字段跳过', () => {
    expect(
      bundleRowOf({
        name: '@deepseek-ai/dsh-base',
        version: '0.2.1-alpha.1',
        description: 'raw',
        enabled: true,
        optional: false,
        removable: false,
        meta: { description: { en: 'Base bundle' } },
      }),
    ).toEqual({
      name: '@deepseek-ai/dsh-base',
      version: '0.2.1-alpha.1',
      description: 'Base bundle',
      enabled: true,
      optional: false,
      removable: false,
    })
    expect(
      bundleRowOf({ name: 'x', enabled: false, error: { code: 'not-bundle' } })?.errorCode,
    ).toBe('not-bundle')
    expect(bundleRowOf({})).toBeNull()
  })

  it('localizedText：字符串 / {en} 取英文回退，其余 undefined', () => {
    expect(localizedText('plain')).toBe('plain')
    expect(localizedText({ en: 'hello' })).toBe('hello')
    expect(localizedText({ zh: '你好' })).toBeUndefined()
    expect(localizedText(undefined)).toBeUndefined()
  })

  it('pluginFailureOf：已知码映射人话，未知码兜底可重试', () => {
    expect(pluginFailureOf('management-required').code).toBe('PLUGIN_MANAGEMENT_REQUIRED')
    expect(pluginFailureOf('unknown-plugin').retryable).toBe(true)
    expect(pluginFailureOf(undefined).code).toBe('PLUGIN_OPERATION_FAILED')
  })
})

describe('isSessionArtifactName', () => {
  it('只匹配会话日志代际、压缩文件与锁文件', () => {
    expect(isSessionArtifactName('session.jsonl')).toBe(true)
    expect(isSessionArtifactName('session.v3.jsonl.zstd')).toBe(true)
    expect(isSessionArtifactName('session.lock')).toBe(true)
    expect(isSessionArtifactName('notes.txt')).toBe(false)
    expect(isSessionArtifactName('session.v3.jsonl.bak')).toBe(false)
  })
})

describe('removeSessionArtifactFiles', () => {
  it('只删除会话日志代际与锁文件，保留同目录其他文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dex-session-delete-'))
    const sessionDir = join(root, 'session-dir')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), 'log')
    writeFileSync(join(sessionDir, 'session.lock'), 'lock')
    writeFileSync(join(sessionDir, 'notes.txt'), 'keep')

    await expect(
      removeSessionArtifactFiles(join(sessionDir, 'session.v3.jsonl.zstd')),
    ).resolves.toBe(true)
    expect(readdirSync(sessionDir)).toEqual(['notes.txt'])
  })

  it('目录已不存在时返回 false', async () => {
    await expect(
      removeSessionArtifactFiles(join(tmpdir(), 'dex-session-missing', 'session.jsonl')),
    ).resolves.toBe(false)
    expect(existsSync(join(tmpdir(), 'dex-session-missing'))).toBe(false)
  })
})
