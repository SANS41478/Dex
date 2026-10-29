import { useEffect, useRef, useState } from 'react'

/**
 * 通用重命名弹窗（会话 / 工作区共用）。
 *
 * 行为照 dsh：自动聚焦并全选、Enter 提交（IME 组合中不提交）、
 * 空标题禁用提交、失败把原始文案显示在 `role="alert"` 里。
 */
export function RenameDialog(input: {
  readonly title: string
  readonly label: string
  readonly initial: string
  readonly onClose: () => void
  /** 返回错误文案表示失败；返回 null 表示成功（由调用方关闭弹窗）。 */
  readonly onSubmit: (value: string) => Promise<string | null>
}) {
  const [draft, setDraft] = useState(input.initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmed = draft.trim()

  // 打开即聚焦并全选（dsh 同行为）；不用 JSX `autoFocus`（a11y 规则禁用）。
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = async (): Promise<void> => {
    if (trimmed === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const failure = await input.onSubmit(trimmed)
      if (failure !== null) {
        setError(failure)
        return
      }
      input.onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rename-backdrop" data-testid="rename-dialog">
      <button
        type="button"
        className="settings-backdrop-hit"
        aria-label="关闭"
        onClick={input.onClose}
      />
      <section className="rename-modal" role="dialog" aria-modal="true" aria-label={input.title}>
        <header className="rename-head">
          <span className="rename-title">{input.title}</span>
          <button
            type="button"
            className="graph-chip"
            onClick={input.onClose}
            data-testid="rename-close"
          >
            取消
          </button>
        </header>
        <label className="rename-field">
          <span className="muted">{input.label}</span>
          <input
            ref={inputRef}
            className="model-input"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                void submit()
              }
            }}
            data-testid="rename-input"
          />
        </label>
        {error !== null ? (
          <p className="model-error" role="alert" data-testid="rename-error">
            {error}
          </p>
        ) : null}
        <div className="rename-actions">
          <button
            type="button"
            className="graph-chip graph-chip-active"
            disabled={busy || trimmed === ''}
            onClick={() => {
              void submit()
            }}
            data-testid="rename-submit"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </div>
  )
}
