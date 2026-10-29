import type { ProjectionDefinitionLike } from '../dsh/session'
import {
  applySessionEvent,
  createInitialProjectionState,
  type TraceProjectionState,
  traceProjectionStateSchema,
} from './trace-fold'

export const TRACE_PROJECTION_KEY = 'dexTrace'
/**
 * v3：增加权限策略与审批审计事件（M3-02c）。
 * v4：`StepRecord.reasoning`（模型思考原文，只增字段）——思考与可见输出分开存，
 *     时间线/执行流才能把「它在想什么」单独呈现。
 */
export const TRACE_PROJECTION_STATE_VERSION = 4

/**
 * 注册到 `ctx.sessionProjections` 的投影单元（key/stateVersion 变更需同步 stateVersion）。
 *
 * `wire` 是**变更流的前提**：dsh 0.1.6 的 `onChanged` 只通知带 `wire` 的单元；
 * 恒等 `view` 让「状态引用变化」直接等价于「需要下发的变更」（fold 未命中事件保持同引用）。
 */
export function createTraceProjection(): ProjectionDefinitionLike<TraceProjectionState> {
  return {
    key: TRACE_PROJECTION_KEY,
    stateVersion: TRACE_PROJECTION_STATE_VERSION,
    stateSchema: traceProjectionStateSchema,
    init: (header) => createInitialProjectionState(header.id),
    apply: (state, event) => applySessionEvent(state, event),
    wire: { viewSchema: traceProjectionStateSchema, view: (state) => state },
  }
}
