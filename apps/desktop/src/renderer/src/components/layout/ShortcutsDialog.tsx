import { useEffect } from 'react'
import { SHORTCUT_GROUPS } from '../../core/shortcuts'

/**
 * 键盘快捷键面板（替代原来的 `window.alert`）。
 *
 * 原实现用 `window.alert` 弹一句话，问题有三：自动化测不出（Playwright 默认自动关掉
 * 原生对话框，于是被记成「死菜单项」，黑盒报告 D11）、样式与应用完全脱节、无法 Esc 关闭。
 * 这里改成应用内模态，复用设置窗的浮层与分区样式，关闭方式与设置窗保持一致。
 */
export function ShortcutsDialog({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    // 与 SettingsDialog 同样的教训：监听挂在 document 上，不依赖某个子节点有没有焦点。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings-backdrop" data-testid="shortcuts-dialog">
      <button
        type="button"
        className="settings-backdrop-hit"
        aria-label="关闭键盘快捷键"
        onClick={onClose}
      />
      <section className="settings-modal" role="dialog" aria-label="键盘快捷键" aria-modal="true">
        <header className="settings-modal-head">
          <span className="settings-modal-title">键盘快捷键</span>
          <button
            type="button"
            className="graph-chip"
            onClick={onClose}
            aria-label="关闭键盘快捷键"
            data-testid="shortcuts-close"
          >
            关闭
          </button>
        </header>
        <div className="settings-modal-body settings-content" data-testid="shortcuts-content">
          {SHORTCUT_GROUPS.map((group) => (
            <section className="settings-section" key={group.title}>
              <h3 className="settings-section-title">{group.title}</h3>
              <ul className="settings-list">
                {group.items.map((item) => (
                  <li key={`${group.title}:${item.keys}`}>
                    <div className="settings-list-item settings-list-item-static">
                      <span className="session-row-title">{item.label}</span>
                      <kbd className="mono">{item.keys}</kbd>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </div>
  )
}
