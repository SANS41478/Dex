import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { clampDetailHeight, readDetailHeight, writeDetailHeight } from '../../core/detail-panel'

export interface DetailPanelProps {
  /** 用于 e2e/诊断定位（沿用既有 `graph-node-detail` / `trace-detail`）。 */
  readonly testId: string
  /** 摘要标题（类型 · 名称）。 */
  readonly title: ReactNode
  /** 摘要态正文：一到两行「这是什么、干什么用的」。 */
  readonly summary: ReactNode
  /** 详情态正文（分段、可滚动）。 */
  readonly children: ReactNode
  readonly onClose: () => void
  /** 摘要态的附加操作（如「只看邻居」），只在摘要态显示。 */
  readonly summaryActions?: ReactNode
  /** 详情态头部的附加操作。 */
  readonly detailActions?: ReactNode
}

/**
 * 两段式详情面板（图谱 / 执行流 / 时间线共用）。
 *
 * 设计约束（用户报告 + 决策 ④）：
 * 1. **首次点击只给短摘要**——回答「这是什么、干什么用的」，不铺满屏；
 * 2. 摘要态是**小浮层**（右下角，限宽限高），详情态**坞在面板底部**，所以详情再大也不会
 *    盖住画布/时间线本体；
 * 3. 详情坞高度可拖拽，并存进 localStorage（下次打开还是这个高度）；
 * 4. `Esc` 两段式退出：先收起详情回到摘要，再按一次关闭。
 */
export function DetailPanel({
  testId,
  title,
  summary,
  children,
  onClose,
  summaryActions,
  detailActions,
}: DetailPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [height, setHeight] = useState(readDetailHeight)
  const rootRef = useRef<HTMLElement>(null)
  const bodyId = useId()

  const collapse = useCallback(() => {
    setExpanded(false)
  }, [])

  // Esc：先收起详情，再关闭面板。原生 dialog 之外的浮层都该有这个退路。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (expanded) collapse()
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [expanded, collapse, onClose])

  /**
   * 拖拽/键盘调高时的可视高度基准 = **父容器**（观测面板）高度。
   *
   * 用面板自身高度当基准是错的：面板越高、上限越高，于是「拖高」会被自己的高度
   * 反复夹住（实测按上方向键反而从 240px 掉到 172px）。
   */
  const containerHeight = useCallback((): number => {
    const parent = rootRef.current?.parentElement
    return parent === null || parent === undefined
      ? window.innerHeight
      : parent.getBoundingClientRect().height
  }, [])

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLHRElement>) => {
      const root = rootRef.current
      if (root === null) return
      const bounds = root.getBoundingClientRect()
      // 手指/指针一旦离开手柄，用 pointer capture 继续收 move —— 否则快速拖动会丢事件。
      event.currentTarget.setPointerCapture(event.pointerId)
      const onMove = (move: PointerEvent): void => {
        setHeight(clampDetailHeight(bounds.bottom - move.clientY, containerHeight()))
      }
      const onUp = (up: PointerEvent): void => {
        const target = up.currentTarget
        if (target instanceof HTMLElement && target.hasPointerCapture(up.pointerId)) {
          target.releasePointerCapture(up.pointerId)
        }
        writeDetailHeight(clampDetailHeight(bounds.bottom - up.clientY, containerHeight()))
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [containerHeight],
  )

  return (
    <aside
      ref={rootRef}
      className={`detail-panel${expanded ? ' detail-panel-expanded' : ' detail-panel-summary'}`}
      data-testid={testId}
      data-expanded={expanded}
      style={expanded ? { height: `${height}px` } : undefined}
    >
      {expanded ? (
        // 拖拽手柄用 `<hr>`（隐式 role=separator）而不是带 role 的 div：
        // 它本来就是一条可聚焦的水平分隔线，键盘也能调高度。
        <hr
          className="detail-panel-resize"
          tabIndex={0}
          aria-label="拖动或按上下方向键调整详情高度"
          aria-valuenow={height}
          data-testid={`${testId}-resize`}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            setHeight((current) => {
              const next = clampDetailHeight(
                current + (event.key === 'ArrowUp' ? 24 : -24),
                containerHeight(),
              )
              writeDetailHeight(next)
              return next
            })
          }}
        />
      ) : null}

      <header className="detail-panel-head">
        <span className="detail-panel-title">{title}</span>
        <div className="detail-panel-head-actions">
          {expanded ? detailActions : null}
          <button
            type="button"
            className="chip detail-panel-toggle"
            onClick={() => {
              setExpanded((value) => !value)
            }}
            aria-expanded={expanded}
            aria-controls={expanded ? bodyId : undefined}
            data-testid={`${testId}-toggle`}
          >
            {expanded ? '收起' : '展开详情'}
          </button>
          <button
            type="button"
            className="detail-panel-close"
            onClick={onClose}
            aria-label="关闭详情"
          >
            ×
          </button>
        </div>
      </header>

      <div className="detail-panel-summary" data-testid={`${testId}-summary`}>
        {summary}
        {!expanded && summaryActions !== undefined ? (
          <div className="detail-panel-summary-actions">{summaryActions}</div>
        ) : null}
      </div>

      {expanded ? (
        <div className="detail-panel-body" id={bodyId} data-testid={`${testId}-body`}>
          {children}
        </div>
      ) : null}
    </aside>
  )
}

/** 详情态里的一个分段（标题 + 内容），默认展开。 */
export function DetailSection({
  title,
  children,
  action,
}: {
  readonly title: string
  readonly children: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <section className="detail-section">
      <header className="detail-section-head">
        <span className="muted">{title}</span>
        {action}
      </header>
      {children}
    </section>
  )
}

/** 键值行（详情态概览用）。 */
export function DetailRows({
  rows,
}: {
  readonly rows: readonly {
    readonly label: string
    readonly value: ReactNode
    readonly mono?: boolean
  }[]
}) {
  return (
    <dl className="detail-rows">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.mono === true ? 'mono' : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 可复制的长文本块（思考原文、工具输出都用它）。 */
export function CopyableText({
  text,
  className,
  testId,
}: {
  readonly text: string
  readonly className?: string | undefined
  readonly testId?: string | undefined
}) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    const clipboard = navigator.clipboard
    if (clipboard === undefined) return
    void clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => undefined)
  }, [text])

  return (
    <div className="detail-copyable" data-testid={testId}>
      <button
        type="button"
        className="chip detail-copy"
        onClick={copy}
        data-testid={testId === undefined ? undefined : `${testId}-copy`}
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre className={className ?? 'detail-pre'}>{text}</pre>
    </div>
  )
}
