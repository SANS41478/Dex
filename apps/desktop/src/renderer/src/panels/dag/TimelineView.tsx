import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filterTurnsByPlugin } from '../../core/linkage'
import {
  buildTimeline,
  countFailedSteps,
  filterFailedTurns,
  formatClock,
  formatDuration,
  formatOffset,
  recentWindow,
  type TimelineStepRow,
  type TimelineTurnGroup,
  toneClass,
} from '../../core/timeline'
import type { TurnRecord } from '../../core/trace'
import { useLinkageStore } from '../../stores/linkageStore'
import { useTraceSelectionStore } from '../../stores/traceSelectionStore'
import { useTraceStore } from '../../stores/traceStore'

/** 距底部多少像素内视为「贴底」（自动跟随恢复阈值）。 */
const FOLLOW_THRESHOLD_PX = 24

/** 一次渲染的轮次上限；超出部分用顶部的「显示更早」按钮按批展开。 */
const TURN_BATCH = 30

/** 只在存在运行中条目时按秒刷新 `now`：驱动时长与几何增长，空闲时零开销。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function barStyle(leftRatio: number, widthRatio: number): { left: string; width: string } {
  return {
    left: `${(leftRatio * 100).toFixed(2)}%`,
    width: `${(widthRatio * 100).toFixed(2)}%`,
  }
}

function toggleInSet(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * 时间线视图（信息架构重做）。
 *
 * 过去的行把六个通道挤在 22px 高的一行里：状态色点（无文字）、`HH:MM:SS.mmm`、按轮次归一化
 * 且没有刻度的时长条、「Step 3」这种没有动作语义的标签、一坨被省略号截断的文本、耗时——
 * 于是「很乱、不知道什么是什么」。现在：
 *
 * - **轮次是章节头**：`第 N 轮` + 提问摘要 + 状态文字 + 总耗时，sticky 且可折叠；
 * - **每步两层**：「动作行」用工具派生的人话（读取文件 README.md）回答「它干了什么」，
 *   「思考行」把模型思考单独放一行（默认首句，可展开全文）——思考与回答不再混在一起；
 * - 状态除颜色外**必有文字**；绝对时间收进 tooltip，行内显示相对本轮的 `+1.2s`；
 * - 默认「行内迷你条」（只表达该步占本轮的比例，不抢注意力）；需要看并行/重叠时切
 *   「时间轴对齐」——那是带轴头刻度的归一化条；
 * - 「只看失败」直接回答「哪一步挂了」；工具行默认收起，避免噪声。
 */
export function TimelineView() {
  const turns = useTraceStore((state) => state.turns)
  const selectedId = useTraceSelectionStore((state) => state.selectedId)
  const toggle = useTraceSelectionStore((state) => state.toggle)
  const pluginFilterId = useLinkageStore((state) => state.pluginFilterId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [failedOnly, setFailedOnly] = useState(false)
  const [alignMode, setAlignMode] = useState(false)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set())
  const [openThoughts, setOpenThoughts] = useState<ReadonlySet<string>>(() => new Set())
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(() => new Set())
  const [turnLimit, setTurnLimit] = useState(TURN_BATCH)

  // L1 过滤：只看调用指定插件的 Step（与 DAG 同源，M2-05）。
  const pluginFiltered = useMemo(
    () => filterTurnsByPlugin(turns, pluginFilterId),
    [turns, pluginFilterId],
  )
  const filtered = useMemo(
    () => (failedOnly ? filterFailedTurns(pluginFiltered) : pluginFiltered),
    [pluginFiltered, failedOnly],
  )
  const windowed = useMemo(() => recentWindow(filtered, turnLimit), [filtered, turnLimit])

  const hasRunning = useMemo(
    () =>
      windowed.items.some(
        (turn) =>
          turn.status === 'running' ||
          turn.steps.some(
            (step) =>
              step.status === 'running' ||
              step.toolCalls.some((toolCall) => toolCall.status === 'running'),
          ),
      ),
    [windowed],
  )
  const now = useNow(hasRunning)
  const model = useMemo(() => buildTimeline(windowed.items, now), [windowed, now])

  const failedCount = useMemo(() => countFailedSteps(filtered), [filtered])

  // 选中来自 DAG/图谱时，把对应行滚进视野；若它是某步的工具，顺手展开该步的工具列。
  useEffect(() => {
    if (selectedId === null) return
    setOpenTools((current) => {
      const owner = findStepOwningTool(pluginFiltered, selectedId)
      return owner === null || current.has(owner) ? current : new Set(current).add(owner)
    })
    const element = scrollRef.current?.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`)
    if (element instanceof HTMLElement) element.scrollIntoView({ block: 'nearest' })
  }, [selectedId, pluginFiltered])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (element === null) return
    setFollowing(
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX,
    )
  }, [])

  // 自动跟随：贴底时滚到最新；用户向上滚动后暂停，滚回底部自动恢复。
  useEffect(() => {
    if (!following || model.rowCount === 0) return
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [model, following])

  const totalSteps = model.turns.reduce((count, turn) => count + turn.steps.length, 0)

  return (
    <div
      className="panel-body timeline"
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="timeline"
      data-following={following}
    >
      <div className="tl-toolbar" data-testid="timeline-toolbar">
        <span className="muted tl-count">
          {model.turns.length} 轮 · {totalSteps} 步 · {failedCount} 失败
        </span>
        <button
          type="button"
          className={`graph-chip${failedOnly ? ' graph-chip-active' : ''}`}
          onClick={() => {
            setFailedOnly((value) => !value)
          }}
          aria-pressed={failedOnly}
          data-testid="timeline-failed-only"
        >
          只看失败
        </button>
        <button
          type="button"
          className={`graph-chip${alignMode ? ' graph-chip-active' : ''}`}
          onClick={() => {
            setAlignMode((value) => !value)
          }}
          aria-pressed={alignMode}
          title="按本轮时间轴对齐显示时长条（跨轮不可比）"
          data-testid="timeline-align"
        >
          时间轴对齐
        </button>
        <button
          type="button"
          className="graph-chip"
          onClick={() => {
            setOpenTools((current) =>
              current.size > 0 ? new Set() : new Set(allStepIds(filtered)),
            )
          }}
          data-testid="timeline-toggle-tools"
        >
          {openTools.size > 0 ? '收起工具行' : '展开工具行'}
        </button>
        <span className="muted tl-follow" data-testid="timeline-following">
          {following ? '跟随最新' : '已暂停跟随'}
        </span>
      </div>

      {windowed.hidden > 0 ? (
        <button
          type="button"
          className="tl-more"
          onClick={() => {
            setTurnLimit((value) => value + TURN_BATCH)
          }}
          data-testid="timeline-more"
        >
          ↑ 显示更早的 {windowed.hidden} 轮
        </button>
      ) : null}

      {model.turns.length === 0 ? (
        <p className="placeholder">
          {pluginFilterId !== null
            ? '该插件没有可展示的 Step'
            : failedOnly
              ? '这次会话还没有失败记录'
              : '等待事件流'}
        </p>
      ) : (
        model.turns.map((turn) => (
          <TurnSection
            key={turn.id}
            turn={turn}
            alignMode={alignMode}
            collapsed={collapsedTurns.has(turn.id)}
            onToggleCollapse={() => {
              setCollapsedTurns((current) => toggleInSet(current, turn.id))
            }}
            selectedId={selectedId}
            onSelect={toggle}
            openThoughts={openThoughts}
            onToggleThought={(stepId) => {
              setOpenThoughts((current) => toggleInSet(current, stepId))
            }}
            openTools={openTools}
            onToggleTools={(stepId) => {
              setOpenTools((current) => toggleInSet(current, stepId))
            }}
          />
        ))
      )}
    </div>
  )
}

function TurnSection({
  turn,
  alignMode,
  collapsed,
  onToggleCollapse,
  selectedId,
  onSelect,
  openThoughts,
  onToggleThought,
  openTools,
  onToggleTools,
}: {
  readonly turn: TimelineTurnGroup
  readonly alignMode: boolean
  readonly collapsed: boolean
  readonly onToggleCollapse: () => void
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly openThoughts: ReadonlySet<string>
  readonly onToggleThought: (stepId: string) => void
  readonly openTools: ReadonlySet<string>
  readonly onToggleTools: (stepId: string) => void
}) {
  return (
    <section
      className={`tl-turn tl-tone-${toneClass(turn.tone)}${collapsed ? ' tl-collapsed' : ''}`}
      data-testid="timeline-turn"
      data-turn-id={turn.id}
    >
      <header className="tl-turn-head">
        <button
          type="button"
          className="tl-turn-caret"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          data-testid="timeline-turn-toggle"
          aria-label={collapsed ? '展开这一轮' : '收起这一轮'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="tl-turn-title">{turn.title}</span>
        <button
          type="button"
          className={`tl-message${selectedId === turn.id ? ' tl-selected' : ''}`}
          data-node-id={turn.id}
          onClick={() => {
            onSelect(turn.id)
          }}
          title={turn.userMessage}
        >
          {turn.message}
        </button>
        <span className={`badge badge-${toneClass(turn.tone)}`}>{turn.statusText}</span>
        {turn.failedCount > 0 ? (
          <span className="tl-fail-count">失败 {turn.failedCount}</span>
        ) : null}
        <span className="muted tl-meta mono">
          {turn.toolCount} 工具 · {turn.spanLabel}
        </span>
      </header>

      {collapsed ? null : (
        <div className="tl-rows">
          {alignMode ? (
            <div className="tl-axis mono" aria-hidden="true">
              <span>0s</span>
              <span className="tl-axis-track" />
              <span>{turn.spanLabel}</span>
            </div>
          ) : null}
          {turn.steps.map((step) => (
            <StepBlock
              key={step.id}
              step={step}
              alignMode={alignMode}
              selectedId={selectedId}
              onSelect={onSelect}
              thoughtOpen={openThoughts.has(step.id)}
              onToggleThought={() => {
                onToggleThought(step.id)
              }}
              toolsOpen={openTools.has(step.id)}
              onToggleTools={() => {
                onToggleTools(step.id)
              }}
            />
          ))}
          {turn.steps.length === 0 ? (
            <p className="muted tl-empty">这一轮还没有产生步骤。</p>
          ) : null}
          {turn.failureMessage !== null ? (
            <p className="tl-failure" role="alert">
              {turn.failureMessage}
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}

function StepBlock({
  step,
  alignMode,
  selectedId,
  onSelect,
  thoughtOpen,
  onToggleThought,
  toolsOpen,
  onToggleTools,
}: {
  readonly step: TimelineStepRow
  readonly alignMode: boolean
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly thoughtOpen: boolean
  readonly onToggleThought: () => void
  readonly toolsOpen: boolean
  readonly onToggleTools: () => void
}) {
  const selected = selectedId === step.id
  // 工具开关放在**副行**而不是动作行：默认观测面板只有约 400px 宽，
  // 把开关塞进动作行会把「这一步做了什么」挤成一个字（实测就只剩「读」）。
  const toolsToggle =
    step.tools.length > 0 ? (
      <button
        type="button"
        className="chip tl-tools-toggle"
        onClick={onToggleTools}
        aria-expanded={toolsOpen}
        title={toolsOpen ? '收起工具行' : `展开 ${step.tools.length} 个工具调用`}
        data-testid="timeline-tools-toggle"
      >
        {toolsOpen ? '▾' : '▸'} 工具 {step.tools.length}
      </button>
    ) : null

  return (
    <div className="tl-step" data-testid="timeline-step">
      <div className="tl-step-line">
        <button
          type="button"
          className={`tl-row tl-action-row tl-tone-${toneClass(step.tone)}${selected ? ' tl-selected' : ''}`}
          data-node-id={step.id}
          onClick={() => {
            onSelect(step.id)
          }}
          title={`${formatClock(step.startedAt)} → ${formatDuration(step.durationMs)}`}
        >
          <span
            className={`tl-rail tl-rail-${toneClass(step.tone)}${step.running ? ' tl-pulse' : ''}`}
          />
          <span className="mono tl-step-label">{step.label}</span>
          <span className={`tl-status tl-status-${toneClass(step.tone)}`}>
            {step.running ? <span className="dot dot-running tl-pulse" /> : null}
            {step.statusText}
          </span>
          <span className="tl-action">{step.action}</span>
          <span className="mono tl-offset">{formatOffset(step.offsetMs)}</span>
          {alignMode ? (
            <span className="tl-bar-track">
              <span
                className={`tl-bar tl-bar-${toneClass(step.tone)}${step.running ? ' tl-pulse-bar' : ''}`}
                style={barStyle(step.leftRatio, step.widthRatio)}
              />
            </span>
          ) : (
            <span className="tl-mini-track">
              <span
                className={`tl-bar tl-bar-${toneClass(step.tone)}${step.running ? ' tl-pulse-bar' : ''}`}
                style={barStyle(step.leftRatio, step.widthRatio)}
              />
            </span>
          )}
          <span className="mono tl-duration">{formatDuration(step.durationMs)}</span>
        </button>
      </div>

      <div className="tl-subline">
        {step.thought !== null ? (
          <div className="tl-thought" data-testid="timeline-thought">
            <button
              type="button"
              className="tl-thought-head"
              onClick={onToggleThought}
              aria-expanded={thoughtOpen}
              data-testid="timeline-thought-toggle"
            >
              <span className="tl-thought-tag">思考</span>
              {thoughtOpen ? null : (
                <span className="tl-thought-summary">{step.thought.summary}</span>
              )}
              <span className="muted tl-thought-meta mono">
                {step.thought.streaming ? '正在思考…' : `${step.thought.chars} 字`}
              </span>
            </button>
            {thoughtOpen ? <pre className="tl-thought-full">{step.thought.text}</pre> : null}
          </div>
        ) : step.running ? (
          <div className="tl-thought tl-thought-pending">
            <span className="tl-thought-tag">思考</span>
            <span className="muted">正在思考…</span>
          </div>
        ) : null}
        {toolsToggle}
      </div>

      {/* 纯文本步骤（没有工具调用）的输出就是它的内容，值得单独一行。 */}
      {step.tools.length === 0 && step.answer !== '' ? (
        <p className="tl-answer">
          <span className="tl-thought-tag">输出</span>
          {step.answer}
        </p>
      ) : null}

      {toolsOpen && step.tools.length > 0 ? (
        <div className="tl-tools" data-testid="timeline-tools">
          {step.tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={`tl-row tl-row-tool${selectedId === tool.id ? ' tl-selected' : ''}`}
              data-node-id={tool.id}
              onClick={() => {
                onSelect(tool.id)
              }}
              title={`${formatClock(tool.startedAt)} → ${formatDuration(tool.durationMs)}`}
            >
              <span
                className={`dot dot-${toneClass(tool.tone)}${tool.running ? ' tl-pulse' : ''}`}
              />
              <span className={`tl-status tl-status-${toneClass(tool.tone)}`}>
                {tool.running ? '进行中' : tool.tone === 'error' ? '失败' : '完成'}
              </span>
              <span className="tl-action">{tool.label}</span>
              <span className="mono tl-offset">{formatOffset(tool.offsetMs)}</span>
              <span className="mono tl-duration">{formatDuration(tool.durationMs)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function findStepOwningTool(turns: readonly TurnRecord[], toolId: string): string | null {
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.toolCalls.some((tool) => tool.id === toolId)) return step.id
    }
  }
  return null
}

function allStepIds(turns: readonly TurnRecord[]): string[] {
  return turns.flatMap((turn) => turn.steps.map((step) => step.id))
}
