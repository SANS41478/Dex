import { type DagStatusTone, effectiveStepTone, effectiveTurnTone, statusTone } from './dag-graph'
import {
  describeStepAction,
  describeToolCall,
  summarizeMessage,
  summarizeThinking,
  TONE_STATUS_LABELS,
  thinkingSize,
  turnOrdinal,
} from './step-summary'
import type { StepRecord, ToolCallRecord, TurnRecord } from './trace'

/** 时长条最小可见宽度（占整轴比例）：极短步骤也能被看到。 */
export const TIMELINE_MIN_BAR_RATIO = 0.02

export type TimelineTone = DagStatusTone

/** tone → 既有样式类后缀（dot-/badge-/chip- 用 success|failed|running|pending）。 */
export function toneClass(tone: TimelineTone): 'success' | 'failed' | 'running' | 'pending' {
  if (tone === 'ok') return 'success'
  if (tone === 'error') return 'failed'
  return tone
}

/** 状态文字：颜色之外必须有文字（color-only 编码对色觉障碍不可用）。 */
export function statusLabel(tone: TimelineTone): string {
  return TONE_STATUS_LABELS[tone]
}

export interface TimelineThoughtRow {
  /** 思考原文（不截断；渲染层决定折叠多少）。 */
  readonly text: string
  /** 首句摘要（默认展示的一行）。 */
  readonly summary: string
  readonly chars: number
  readonly lines: number
  readonly streaming: boolean
}

export interface TimelineToolRow {
  readonly id: string
  /** 人话动作 + 宾语，如「读取文件 README.md」。 */
  readonly label: string
  readonly toolName: string
  readonly tone: TimelineTone
  readonly running: boolean
  readonly pluginId: string
  readonly startedAt: number
  readonly durationMs: number
  /** 相对本轮起点的偏移（毫秒），用于「+1.2s」。 */
  readonly offsetMs: number
  /** 时间轴几何（0..1，相对所属 turn 的时间范围）。 */
  readonly leftRatio: number
  readonly widthRatio: number
}

export interface TimelineStepRow {
  readonly id: string
  /** 1 基序号。 */
  readonly ordinal: number
  readonly label: string
  /** 「这一步做了什么」的人话动作。 */
  readonly action: string
  readonly tone: TimelineTone
  readonly running: boolean
  readonly statusText: string
  readonly startedAt: number
  readonly offsetMs: number
  readonly durationMs: number
  readonly leftRatio: number
  readonly widthRatio: number
  /** 模型思考（无思考为 null）。 */
  readonly thought: TimelineThoughtRow | null
  /** 可见输出文本（回答/旁白）。 */
  readonly answer: string
  readonly tools: TimelineToolRow[]
}

export interface TimelineTurnGroup {
  readonly id: string
  /** 轮次序号（从 turn id 的 `:tN` 解析）。 */
  readonly ordinal: number
  readonly title: string
  readonly userMessage: string
  readonly message: string
  readonly tone: TimelineTone
  readonly runStatus: TurnRecord['status']
  readonly running: boolean
  readonly startedAt: number
  readonly durationMs: number
  readonly statusText: string
  readonly steps: TimelineStepRow[]
  readonly failedCount: number
  readonly toolCount: number
  /** 该轮时间轴总跨度文案（时间轴对齐视图的轴头）。 */
  readonly spanLabel: string
  readonly failureMessage: string | null
}

export interface TimelineModel {
  /** 时间正序（旧 → 新），与自动贴底（底部为最新）一致。 */
  readonly turns: TimelineTurnGroup[]
  readonly hasRunning: boolean
  readonly rowCount: number
  readonly failedCount: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 把 [start, end] 映射成整轴上的条几何；end 缺省取轴终点（运行中）。 */
function barGeometry(
  start: number,
  end: number | undefined,
  spanStart: number,
  spanEnd: number,
): { leftRatio: number; widthRatio: number } {
  const span = Math.max(1, spanEnd - spanStart)
  const effectiveEnd = Math.max(end ?? spanEnd, start)
  const rawLeft = clamp01((start - spanStart) / span)
  // 靠右边界时把起点左移保底宽度，保证 条不越出轴（left + width <= 1）。
  const leftRatio = Math.min(rawLeft, 1 - TIMELINE_MIN_BAR_RATIO)
  const widthRaw = (effectiveEnd - start) / span
  return {
    leftRatio,
    widthRatio: Math.min(Math.max(widthRaw, TIMELINE_MIN_BAR_RATIO), 1 - leftRatio),
  }
}

function durationOf(
  record: { readonly startedAt: number; readonly endedAt?: number | undefined },
  now: number,
): number {
  return Math.max(0, (record.endedAt ?? now) - record.startedAt)
}

function toolRow(
  tool: ToolCallRecord,
  turnStart: number,
  spanStart: number,
  spanEnd: number,
  now: number,
): TimelineToolRow {
  const geometry = barGeometry(tool.startedAt, tool.endedAt, spanStart, spanEnd)
  const tone = statusTone(tool.status)
  return {
    id: tool.id,
    label: describeToolCall(tool),
    toolName: tool.toolName,
    tone,
    running: tool.status === 'running',
    pluginId: tool.pluginId,
    startedAt: tool.startedAt,
    durationMs: tool.durationMs ?? durationOf(tool, now),
    offsetMs: Math.max(0, tool.startedAt - turnStart),
    ...geometry,
  }
}

function thoughtRow(step: StepRecord): TimelineThoughtRow | null {
  const text = step.reasoning
  if (text === undefined || text.trim() === '') return null
  const size = thinkingSize(text)
  return {
    text,
    summary: summarizeThinking(text),
    chars: size.chars,
    lines: size.lines,
    streaming: step.status === 'running',
  }
}

function stepRow(
  step: StepRecord,
  turnStart: number,
  spanStart: number,
  spanEnd: number,
  now: number,
): TimelineStepRow {
  const geometry = barGeometry(step.startedAt, step.endedAt, spanStart, spanEnd)
  const tone = effectiveStepTone(step)
  const action = describeStepAction(step)
  return {
    id: step.id,
    ordinal: step.index + 1,
    label: `Step ${step.index + 1}`,
    action: action.text,
    // 失败传播：工具失败染红所属 Step（PRD 5.2）
    tone,
    running: step.status === 'running',
    statusText: statusLabel(tone),
    startedAt: step.startedAt,
    offsetMs: Math.max(0, step.startedAt - turnStart),
    durationMs: durationOf(step, now),
    ...geometry,
    thought: thoughtRow(step),
    answer: step.llmReasoning,
    tools: step.toolCalls.map((tool) => toolRow(tool, turnStart, spanStart, spanEnd, now)),
  }
}

/**
 * trace 记录 → 时间线视图模型（纯函数）。
 * 每个 turn 以自己的时间范围归一（运行中取 `now` 为轴终点），step/tool 共用该轴；
 * `now` 仅用于运行中条目的时长与几何，测试注入固定时钟。
 */
export function buildTimeline(turns: readonly TurnRecord[], now: number): TimelineModel {
  const groups: TimelineTurnGroup[] = []
  let hasRunning = false
  let rowCount = 0
  let failedCount = 0

  for (const [turnIndex, turn] of turns.entries()) {
    const spanEnd = turn.endedAt ?? now
    // 失败传播：任一 Step 红 → Turn 红（PRD 5.2）
    const tone = effectiveTurnTone(turn)
    const running = turn.status === 'running'
    const steps = turn.steps.map((step) =>
      stepRow(step, turn.startedAt, turn.startedAt, spanEnd, now),
    )
    const turnFailed = steps.filter((step) => step.tone === 'error').length
    const toolCount = steps.reduce((count, step) => count + step.tools.length, 0)
    failedCount += turnFailed

    hasRunning ||=
      running || steps.some((step) => step.running || step.tools.some((tool) => tool.running))
    // 折叠态下的行数：1（轮次头）+ 每步 2 行（动作 + 思考）；工具行按需展开，不计入。
    rowCount += 1 + steps.length * 2
    const durationMs = durationOf(turn, now)
    groups.push({
      id: turn.id,
      ordinal: turnOrdinal(turn.id, turnIndex),
      title: `第 ${turnOrdinal(turn.id, turnIndex)} 轮`,
      userMessage: turn.userMessage,
      message: summarizeMessage(turn.userMessage),
      tone,
      runStatus: turn.status,
      running,
      startedAt: turn.startedAt,
      durationMs,
      statusText: statusLabel(tone),
      steps,
      failedCount: turnFailed,
      toolCount,
      spanLabel: formatDuration(durationMs),
      failureMessage: turn.failureMessage ?? null,
    })
  }

  return { turns: groups, hasRunning, rowCount, failedCount }
}

/**
 * 「只看失败」过滤：保留含失败 Step 的 turn，且只留失败的 Step。
 * 空结果是**合法**的（这一轮没有失败），UI 负责显示空态。
 */
export function filterFailedTurns(turns: readonly TurnRecord[]): readonly TurnRecord[] {
  const filtered: TurnRecord[] = []
  for (const turn of turns) {
    const steps = turn.steps.filter((step) => effectiveStepTone(step) === 'error')
    if (steps.length > 0) filtered.push({ ...turn, steps })
  }
  return filtered
}

/** 失败 Step 计数（工具栏「N 失败」用；避免为计数再走一遍完整建模）。 */
export function countFailedSteps(turns: readonly TurnRecord[]): number {
  let count = 0
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (effectiveStepTone(step) === 'error') count += 1
    }
  }
  return count
}

export interface RecentWindow<T> {
  readonly items: readonly T[]
  readonly hidden: number
}

/**
 * 只渲染最近的 `limit` 个条目，并报出被隐藏的数量。
 *
 * 时间线可能累积数百轮（design-system §05 第 94 行要求「虚拟滚动」）；这里用
 * 「窗口 + 显式展开更早」替代真正的虚拟滚动：实现简单、不会因为变高行算出错滚动位置，
 * 而用户想要的「最新的都在」这条语义是明确的。
 */
export function recentWindow<T>(items: readonly T[], limit: number): RecentWindow<T> {
  if (limit <= 0 || items.length <= limit) return { items, hidden: 0 }
  return { items: items.slice(items.length - limit), hidden: items.length - limit }
}

const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
/** 本地时钟 `HH:MM:SS.mmm`。 */
export function formatClock(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** 人话时长：`850ms` / `1.2s` / `2m03s`。 */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms))
  if (safe < 1000) return `${safe}ms`
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1000)
  return `${minutes}m${pad(seconds)}s`
}

/** 相对时间：`+1.2s`（行内用，绝对时间进 tooltip）。 */
export function formatOffset(ms: number): string {
  return `+${formatDuration(ms)}`
}

/** 选中切换语义：点已选中项 → 取消；否则选中新项。 */
export function nextSelection(current: string | null, id: string): string | null {
  return current === id ? null : id
}
