import type { StepRecord, ToolCallRecord, TurnRecord } from './trace'

/** 执行流选中记录（turn / step / tool 三级）。 */
export interface TraceSelection {
  readonly kind: 'turn' | 'step' | 'tool'
  readonly turn: TurnRecord
  readonly step?: StepRecord
  readonly tool?: ToolCallRecord
}

/** 按 id 在执行流记录里定位选中项；找不到返回 null（过滤后失效的选中）。 */
export function findTraceSelection(
  selectedId: string | null,
  turns: readonly TurnRecord[],
): TraceSelection | null {
  if (selectedId === null) return null
  for (const turn of turns) {
    if (turn.id === selectedId) return { kind: 'turn', turn }
    for (const step of turn.steps) {
      if (step.id === selectedId) return { kind: 'step', turn, step }
      for (const tool of step.toolCalls) {
        if (tool.id === selectedId) return { kind: 'tool', turn, step, tool }
      }
    }
  }
  return null
}

/** 选中项关联的插件节点 id（去重、忽略 unknown）：与 M1 图谱节点 id 对齐。 */
export function pluginsOfSelection(selection: TraceSelection | null): string[] {
  if (selection === null) return []
  const ids = new Set<string>()
  const addTool = (tool: ToolCallRecord): void => {
    if (tool.pluginId !== 'unknown') ids.add(tool.pluginId)
  }
  const addStep = (step: StepRecord): void => {
    for (const tool of step.toolCalls) addTool(tool)
  }

  if (selection.kind === 'tool') {
    if (selection.tool !== undefined) addTool(selection.tool)
  } else if (selection.kind === 'step') {
    if (selection.step !== undefined) addStep(selection.step)
  } else {
    for (const step of selection.turn.steps) addStep(step)
  }
  return [...ids]
}

export function stepUsesPlugin(step: StepRecord, pluginId: string): boolean {
  return step.toolCalls.some((tool) => tool.pluginId === pluginId)
}

/**
 * 过滤出调用该插件的 Step：保留匹配 Step 的全部工具与其所在 turn；
 * 无匹配 Step 的 turn 整组丢弃。`pluginId` 为 null 时原样返回（同引用）。
 */
export function filterTurnsByPlugin(
  turns: readonly TurnRecord[],
  pluginId: string | null,
): readonly TurnRecord[] {
  if (pluginId === null) return turns
  const filtered: TurnRecord[] = []
  for (const turn of turns) {
    const steps = turn.steps.filter((step) => stepUsesPlugin(step, pluginId))
    if (steps.length === 0) continue
    filtered.push({ ...turn, steps })
  }
  return filtered
}
