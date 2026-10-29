import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  formatClock,
  formatDuration,
  formatOffset,
  nextSelection,
  statusLabel,
  TIMELINE_MIN_BAR_RATIO,
  toneClass,
} from './timeline'
import type { StepRecord, ToolCallRecord, TurnRecord } from './trace'

function tool(
  partial: Partial<ToolCallRecord> & { id: string; startedAt: number },
): ToolCallRecord {
  return {
    stepId: 's1',
    toolName: 'read',
    pluginId: 'unknown',
    input: {},
    status: 'running',
    ...partial,
  }
}

function step(partial: Partial<StepRecord> & { id: string; startedAt: number }): StepRecord {
  return {
    turnId: 'sess:t1',
    index: 0,
    llmReasoning: '',
    status: 'running',
    toolCalls: [],
    ...partial,
  }
}

function turn(partial: Partial<TurnRecord> & { id: string; startedAt: number }): TurnRecord {
  return {
    userMessage: '看看项目',
    status: 'running',
    steps: [],
    ...partial,
  }
}

describe('buildTimeline', () => {
  it('按时间正序分组，step/tool 共用 turn 轴并计算几何', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 't1',
        startedAt: 1000,
        endedAt: 2000,
        status: 'completed',
        steps: [
          step({
            id: 's1',
            startedAt: 1000,
            endedAt: 1200,
            status: 'success',
            llmReasoning: '先读 README',
            toolCalls: [
              tool({
                id: 'c1',
                startedAt: 1100,
                endedAt: 1500,
                status: 'success',
                durationMs: 400,
              }),
            ],
          }),
          step({ id: 's2', startedAt: 1500, endedAt: 2000, status: 'failed' }),
        ],
      }),
    ]

    const model = buildTimeline(turns, 9999)
    expect(model.turns.map((group) => group.id)).toEqual(['t1'])
    // 折叠态行数 = 1（轮次头）+ 每步 2 行（动作 + 思考）
    expect(model.rowCount).toBe(5)
    expect(model.hasRunning).toBe(false)

    const group = model.turns[0]
    if (group === undefined) throw new Error('expected group')
    expect(group.durationMs).toBe(1000)
    // Step 2 失败 → 失败传播到 Turn（PRD 5.2）
    expect(group.tone).toBe('error')

    const first = group.steps[0]
    if (first === undefined) throw new Error('expected step')
    expect(first.leftRatio).toBeCloseTo(0)
    expect(first.widthRatio).toBeCloseTo(0.2)
    expect(first.answer).toBe('先读 README')
    expect(first.startedAt).toBe(1000)

    const call = first.tools[0]
    if (call === undefined) throw new Error('expected tool')
    expect(call.leftRatio).toBeCloseTo(0.1)
    expect(call.widthRatio).toBeCloseTo(0.4)
    expect(call.durationMs).toBe(400)
    expect(call.tone).toBe('ok')

    expect(group.steps[1]?.tone).toBe('error')
  })

  it('运行中条目以 now 为轴终点，时长随 now 增长', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 't1',
        startedAt: 0,
        status: 'running',
        steps: [
          step({
            id: 's1',
            startedAt: 0,
            status: 'running',
            toolCalls: [tool({ id: 'c1', startedAt: 500, status: 'running' })],
          }),
        ],
      }),
    ]

    const at1000 = buildTimeline(turns, 1000)
    expect(at1000.hasRunning).toBe(true)
    expect(at1000.turns[0]?.durationMs).toBe(1000)
    expect(at1000.turns[0]?.steps[0]?.durationMs).toBe(1000)
    expect(at1000.turns[0]?.steps[0]?.tools[0]?.durationMs).toBe(500)
    expect(at1000.turns[0]?.steps[0]?.tools[0]?.leftRatio).toBeCloseTo(0.5)

    const at3000 = buildTimeline(turns, 3000)
    expect(at3000.turns[0]?.durationMs).toBe(3000)
    expect(at3000.turns[0]?.steps[0]?.tools[0]?.leftRatio).toBeCloseTo(500 / 3000)
  })

  it('极短条目有最小可见宽度，且不越出右边界', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 't1',
        startedAt: 0,
        endedAt: 10_000,
        status: 'completed',
        steps: [
          step({ id: 's1', startedAt: 0, endedAt: 1, status: 'success' }),
          step({ id: 's2', startedAt: 9_999, endedAt: 10_000, status: 'success' }),
        ],
      }),
    ]
    const model = buildTimeline(turns, 0)
    const first = model.turns[0]?.steps[0]
    const last = model.turns[0]?.steps[1]
    if (first === undefined || last === undefined) throw new Error('expected steps')
    expect(first.widthRatio).toBeGreaterThanOrEqual(TIMELINE_MIN_BAR_RATIO)
    expect(last.leftRatio + last.widthRatio).toBeLessThanOrEqual(1 + Number.EPSILON)
  })

  it('空输入返回空模型', () => {
    expect(buildTimeline([], 0)).toEqual({
      turns: [],
      hasRunning: false,
      rowCount: 0,
      failedCount: 0,
    })
  })

  it('动作短语由工具调用派生，思考与回答分开成行', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 'sess:t7',
        startedAt: 0,
        endedAt: 900,
        status: 'completed',
        steps: [
          step({
            id: 's1',
            startedAt: 0,
            endedAt: 400,
            status: 'success',
            reasoning: '用户在问项目结构。\n先读 README 最省事。',
            llmReasoning: '我先读一下 README。',
            toolCalls: [
              tool({
                id: 'c1',
                startedAt: 100,
                endedAt: 400,
                status: 'success',
                toolName: 'read',
                input: { path: 'README.md' },
              }),
              tool({
                id: 'c2',
                startedAt: 400,
                endedAt: 800,
                status: 'success',
                toolName: 'grep',
                input: { pattern: 'TODO' },
              }),
            ],
          }),
        ],
      }),
    ]
    const group = buildTimeline(turns, 0).turns[0]
    if (group === undefined) throw new Error('expected group')

    // 轮次标题：序号来自 `:t7`，不再显示原始 id
    expect(group.ordinal).toBe(7)
    expect(group.title).toBe('第 7 轮')
    expect(group.toolCount).toBe(2)
    expect(group.failedCount).toBe(0)

    const row = group.steps[0]
    if (row === undefined) throw new Error('expected step row')
    // 动作行：人话动作而不是模型原话
    expect(row.action).toBe('读取文件 等 2 项操作 · README.md')
    expect(row.statusText).toBe('完成')
    expect(row.offsetMs).toBe(0)
    // 思考行：首句摘要 + 原文保留
    expect(row.thought?.summary).toBe('用户在问项目结构。')
    expect(row.thought?.text).toContain('先读 README 最省事')
    expect(row.thought?.streaming).toBe(false)
    expect(row.answer).toBe('我先读一下 README。')
  })

  it('无工具调用的步骤退化为「生成回复」', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 'sess:t1',
        startedAt: 0,
        endedAt: 10,
        status: 'completed',
        steps: [step({ id: 's1', startedAt: 0, endedAt: 10, status: 'success' })],
      }),
    ]
    const row = buildTimeline(turns, 0).turns[0]?.steps[0]
    expect(row?.action).toBe('生成回复')
    expect(row?.tools).toHaveLength(0)
    expect(row?.thought).toBeNull()
  })

  it('运行中的思考标记为 streaming，思考随 now 增长', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 'sess:t1',
        startedAt: 0,
        status: 'running',
        steps: [step({ id: 's1', startedAt: 0, status: 'running', reasoning: '正在想' })],
      }),
    ]
    expect(buildTimeline(turns, 500).turns[0]?.steps[0]?.thought?.streaming).toBe(true)
  })

  it('失败传播：工具失败染红 Step 与 Turn（记录自身 completed）', () => {
    const turns: TurnRecord[] = [
      turn({
        id: 't1',
        startedAt: 0,
        endedAt: 100,
        status: 'completed',
        steps: [
          step({
            id: 's1',
            startedAt: 0,
            endedAt: 50,
            status: 'success',
            toolCalls: [
              tool({ id: 'c1', startedAt: 0, endedAt: 10, status: 'failed' }),
              tool({ id: 'c2', startedAt: 10, endedAt: 20, status: 'success' }),
            ],
          }),
        ],
      }),
    ]
    const model = buildTimeline(turns, 200)
    expect(model.turns[0]?.tone).toBe('error')
    expect(model.turns[0]?.steps[0]?.tone).toBe('error')
    expect(model.turns[0]?.steps[0]?.tools[0]?.tone).toBe('error')
    expect(model.turns[0]?.steps[0]?.tools[1]?.tone).toBe('ok')
    expect(model.turns[0]?.running).toBe(false)
  })
})

describe('格式化与工具函数', () => {
  it('formatClock 输出本地 HH:MM:SS.mmm', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5, 6).getTime())).toBe('03:04:05.006')
  })

  it('formatDuration 分档输出', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(123_000)).toBe('2m03s')
  })

  it('formatOffset 输出相对时间，statusLabel 给颜色之外的文字', () => {
    expect(formatOffset(0)).toBe('+0ms')
    expect(formatOffset(1234)).toBe('+1.2s')
    expect(statusLabel('ok')).toBe('完成')
    expect(statusLabel('error')).toBe('失败')
    expect(statusLabel('running')).toBe('进行中')
    expect(statusLabel('pending')).toBe('待开始')
  })

  it('toneClass 把语义 tone 映射到既有样式类', () => {
    expect(toneClass('ok')).toBe('success')
    expect(toneClass('error')).toBe('failed')
    expect(toneClass('running')).toBe('running')
    expect(toneClass('pending')).toBe('pending')
  })

  it('nextSelection 点击已选中项取消，否则选中', () => {
    expect(nextSelection(null, 's1')).toBe('s1')
    expect(nextSelection('s1', 's1')).toBeNull()
    expect(nextSelection('s1', 's2')).toBe('s2')
  })
})
