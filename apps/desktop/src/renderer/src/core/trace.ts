import {
  applyTraceMessage,
  initialTraceState,
  type StepRecord,
  type ToolCallRecord,
  type TraceState,
  type TurnRecord,
  truncateTraceStateAtStep,
} from '@dexagent/shared'

export type { ApprovalRecord, PolicyChange } from '@dexagent/shared'
export type { StepRecord, ToolCallRecord, TraceState, TurnRecord }
export { applyTraceMessage, initialTraceState, truncateTraceStateAtStep }
