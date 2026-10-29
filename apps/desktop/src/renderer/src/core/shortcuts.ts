/**
 * 全应用快捷键：**只登记真正实现了的**。
 *
 * 这里刻意不做「文档式清单」。原实现在「帮助 → 键盘快捷键」里弹了一句
 * `Enter 发送 · Shift+Enter 换行 · Ctrl/Cmd+K 搜索`，但 `Ctrl+K` 从来没有实现过
 * （全仓找不到任何 `keydown` 监听），用户照着按只会得到「没反应」——黑盒报告因此
 * 把该菜单项记成「死菜单项」（D11）。清单与实现必须是同一份事实。
 */

/** 归一化后的按键事件，便于纯函数测试（不依赖 DOM 事件对象）。 */
export interface ShortcutKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** 由全局 keydown 处理的动作；`null` 表示这一下不归我们管。 */
export type ShortcutAction = 'focus-session-search' | 'new-chat'

/** 跨平台的「主修饰键」：macOS 上是 ⌘，其他平台是 Ctrl。 */
function hasPrimaryModifier(event: ShortcutKeyEvent): boolean {
  return event.ctrlKey || event.metaKey
}

/**
 * 把一次按键映射成全局动作。
 *
 * 约束：必须带主修饰键、不能带 Alt、不能带 Shift（`Ctrl+Shift+K` 之类留给 DevTools /
 * 系统，不去抢）。
 */
export function matchShortcut(event: ShortcutKeyEvent): ShortcutAction | null {
  if (!hasPrimaryModifier(event) || event.altKey || event.shiftKey) return null
  switch (event.key.toLowerCase()) {
    case 'k':
      return 'focus-session-search'
    case 'n':
      return 'new-chat'
    default:
      return null
  }
}

export interface ShortcutEntry {
  readonly keys: string
  readonly label: string
}

export interface ShortcutGroup {
  readonly title: string
  readonly items: readonly ShortcutEntry[]
}

/**
 * 展示用清单。**每一条都必须能在代码里找到对应实现**：
 * - 全局两条 = `matchShortcut`；
 * - 输入框两条 = `Composer` 的 textarea `onKeyDown`；
 * - 窗口一条 = `SettingsDialog` / `ShortcutsDialog` 的 Esc 关闭；
 * - 编辑三条 = 标题栏「编辑」菜单（调用 Chromium 的 `document.execCommand`）。
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      { keys: 'Ctrl / ⌘ + K', label: '聚焦会话搜索' },
      { keys: 'Ctrl / ⌘ + N', label: '新建对话' },
    ],
  },
  {
    title: '输入框',
    items: [
      { keys: 'Enter', label: '发送' },
      { keys: 'Shift + Enter', label: '换行' },
    ],
  },
  {
    title: '窗口',
    items: [{ keys: 'Esc', label: '关闭设置窗口 / 本面板' }],
  },
  {
    title: '编辑',
    items: [
      { keys: 'Ctrl / ⌘ + C', label: '复制' },
      { keys: 'Ctrl / ⌘ + V', label: '粘贴' },
      { keys: 'Ctrl / ⌘ + A', label: '全选' },
    ],
  },
]
