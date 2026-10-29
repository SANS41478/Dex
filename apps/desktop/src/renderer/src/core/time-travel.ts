import type { StepRecord, TurnRecord } from './trace'

export interface TraceStepOption {
  readonly id: string
  readonly turnId: string
  readonly index: number
  readonly label: string
  readonly step: StepRecord
}

export function listTraceSteps(turns: readonly TurnRecord[]): readonly TraceStepOption[] {
  const options: TraceStepOption[] = []
  for (const turn of turns) {
    for (const step of turn.steps) {
      options.push({
        id: step.id,
        turnId: turn.id,
        index: step.index,
        label: `${turn.id} · Step ${step.index + 1}`,
        step,
      })
    }
  }
  return options
}
