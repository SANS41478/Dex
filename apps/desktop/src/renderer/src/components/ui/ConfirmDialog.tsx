import { useState } from 'react'

/** 应用内确认弹窗（归档运行中会话 / 删除工作区等破坏性操作）。 */
export function ConfirmDialog(input: {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly danger?: boolean
  readonly onConfirm: () => void | Promise<void>
  readonly onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="rename-backdrop" data-testid="confirm-dialog">
      <button
        type="button"
        className="settings-backdrop-hit"
        aria-label="关闭"
        onClick={input.onClose}
      />
      <section
        className="rename-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={input.title}
      >
        <header className="rename-head">
          <span className="rename-title">{input.title}</span>
        </header>
        <p className="muted">{input.description}</p>
        <div className="rename-actions">
          <button
            type="button"
            className="graph-chip"
            disabled={busy}
            onClick={input.onClose}
            data-testid="confirm-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={`graph-chip${input.danger === true ? ' graph-chip-danger' : ' graph-chip-active'}`}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void Promise.resolve(input.onConfirm()).finally(() => setBusy(false))
            }}
            data-testid="confirm-accept"
          >
            {busy ? '处理中…' : input.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
