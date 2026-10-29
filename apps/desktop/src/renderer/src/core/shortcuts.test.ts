import { describe, expect, it } from 'vitest'
import { matchShortcut, SHORTCUT_GROUPS, type ShortcutKeyEvent } from './shortcuts'

const key = (input: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...input,
})

describe('matchShortcut', () => {
  it('Ctrl+K / ⌘K 聚焦会话搜索', () => {
    expect(matchShortcut(key({ key: 'k', ctrlKey: true }))).toBe('focus-session-search')
    expect(matchShortcut(key({ key: 'K', metaKey: true }))).toBe('focus-session-search')
  })

  it('Ctrl+N / ⌘N 新建对话', () => {
    expect(matchShortcut(key({ key: 'n', ctrlKey: true }))).toBe('new-chat')
  })

  it('不带主修饰键的一律不接管（普通输入不受影响）', () => {
    expect(matchShortcut(key({ key: 'k' }))).toBeNull()
    expect(matchShortcut(key({ key: 'n' }))).toBeNull()
  })

  it('不抢 Alt / Shift 组合（留给系统与 DevTools）', () => {
    expect(matchShortcut(key({ key: 'k', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key({ key: 'k', ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('无关按键返回 null', () => {
    expect(matchShortcut(key({ key: 'Enter', ctrlKey: true }))).toBeNull()
  })
})

describe('SHORTCUT_GROUPS', () => {
  it('每个分组都有内容，且不存在空条目', () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0)
    for (const group of SHORTCUT_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0)
      for (const item of group.items) {
        expect(item.keys.trim()).not.toBe('')
        expect(item.label.trim()).not.toBe('')
      }
    }
  })
})
