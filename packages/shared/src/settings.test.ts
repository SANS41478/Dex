import { describe, expect, it } from 'vitest'
import {
  settingsDescribeSchema,
  settingsMutateRequestSchema,
  settingsNamespaceSchema,
} from './settings'

const namespace = {
  autoGenerate: true,
  ns: 'general',
  schema: { uid: 'root', refs: { root: { type: 'object' } } },
  value: { theme: 'dark' },
  applies: 'live' as const,
  secrets: [{ path: ['apiKey'], set: true }],
  revision: 3,
}

describe('dsh settings contracts', () => {
  it('accepts a redacted settings descriptor and preserves schema/value JSON', () => {
    expect(settingsNamespaceSchema.parse(namespace).value).toEqual({ theme: 'dark' })
    expect(
      settingsDescribeSchema.parse({ writable: true, hasDocument: true, namespaces: [namespace] })
        .namespaces,
    ).toHaveLength(1)
  })

  it('requires a revision-fenced path mutation and rejects empty paths or values', () => {
    expect(
      settingsMutateRequestSchema.safeParse({
        namespace: 'general',
        operations: [{ op: 'set', path: ['theme'], value: 'light' }],
        expectedRevision: 3,
      }).success,
    ).toBe(true)
    expect(
      settingsMutateRequestSchema.safeParse({
        namespace: 'general',
        operations: [{ op: 'unset', path: [] }],
        expectedRevision: 3,
      }).success,
    ).toBe(false)
    expect(
      settingsMutateRequestSchema.safeParse({
        namespace: 'general',
        operations: [],
        expectedRevision: 3,
      }).success,
    ).toBe(false)
  })
})
