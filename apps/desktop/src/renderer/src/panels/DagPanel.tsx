import { lazy, Suspense, useEffect, useMemo } from 'react'
import { filterTurnsByPlugin, findTraceSelection } from '../core/linkage'
import { listTraceSteps } from '../core/time-travel'
import { useConnectionStore } from '../stores/connectionStore'
import { useLinkageStore } from '../stores/linkageStore'
import type { ObserverFlowView } from '../stores/observerStore'
import { useTraceSelectionStore } from '../stores/traceSelectionStore'
import { useTraceStore } from '../stores/traceStore'
import { TimelineView } from './dag/TimelineView'
import { TraceDetailCard } from './dag/TraceDetailCard'
import { LinkageFilterChip } from './LinkageFilterChip'

// DAG 视图（React Flow + ELK）懒加载：独立 chunk，首屏不受布局库体积影响。
const DagView = lazy(() => import('./dag/DagView').then((module) => ({ default: module.DagView })))

export type DagViewMode = ObserverFlowView

export function DagPanel({
  view = 'dag',
  onViewChange,
}: {
  readonly view?: DagViewMode
  readonly onViewChange?: (view: DagViewMode) => void
}) {
  const receivedCount = useConnectionStore((state) => state.receivedCount)
  const turns = useTraceStore((state) => state.turns)
  const sourceTurns = useTraceStore((state) => state.sourceState.turns)
  const policyChanges = useTraceStore((state) => state.policyChanges)
  const approvals = useTraceStore((state) => state.approvals)
  const timeTravelStepId = useTraceStore((state) => state.timeTravelStepId)
  const timeTravelError = useTraceStore((state) => state.timeTravelError)
  const enterTimeTravel = useTraceStore((state) => state.enterTimeTravel)
  const previousStep = useTraceStore((state) => state.previousStep)
  const nextStep = useTraceStore((state) => state.nextStep)
  const exitTimeTravel = useTraceStore((state) => state.exitTimeTravel)
  const selectedId = useTraceSelectionStore((state) => state.selectedId)
  const select = useTraceSelectionStore((state) => state.select)
  const pluginFilterId = useLinkageStore((state) => state.pluginFilterId)
  const requestGraphFocus = useLinkageStore((state) => state.requestGraphFocus)
  const timeTravelSteps = useMemo(() => listTraceSteps(sourceTurns), [sourceTurns])
  const timeTravelIndex = timeTravelSteps.findIndex((step) => step.id === timeTravelStepId)

  // 选中记录按「过滤后」的数据解析：过滤把选中项排除时自动清选（详情卡不指向不可见节点）。
  const selection = useMemo(
    () => findTraceSelection(selectedId, filterTurnsByPlugin(turns, pluginFilterId)),
    [selectedId, turns, pluginFilterId],
  )

  useEffect(() => {
    if (selectedId !== null && selection === null) select(null)
  }, [selectedId, selection, select])

  return (
    <section className="panel" data-testid="panel-dag">
      <header className="panel-header observer-flow-header">
        <nav className="observer-tabs" aria-label="执行流视图">
          {(['dag', 'timeline'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`observer-tab${view === item ? ' observer-tab-active' : ''}`}
              aria-pressed={view === item}
              data-testid={`observer-tab-${item}`}
              onClick={() => onViewChange?.(item)}
            >
              {item === 'dag' ? '执行流' : '时间线'}
            </button>
          ))}
        </nav>
        <span className="panel-header-actions">
          <LinkageFilterChip />
          <span className="muted" data-testid="event-count">
            已接收事件 {receivedCount} · <span data-testid="turn-count">Turn {turns.length}</span>
          </span>
        </span>
      </header>
      <div className="time-travel-bar" data-testid="time-travel-controls">
        <span className="muted">时间旅行</span>
        <select
          className="time-travel-select"
          value={timeTravelStepId ?? ''}
          onChange={(event) => {
            if (event.target.value === '') exitTimeTravel()
            else enterTimeTravel(event.target.value)
          }}
          disabled={timeTravelSteps.length === 0}
          aria-label="选择历史 Step"
          data-testid="time-travel-step"
        >
          <option value="">实时状态</option>
          {timeTravelSteps.map((step) => (
            <option key={step.id} value={step.id}>
              {step.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="graph-chip"
          onClick={previousStep}
          disabled={timeTravelIndex <= 0}
          data-testid="time-travel-previous"
        >
          上一步
        </button>
        <button
          type="button"
          className="graph-chip"
          onClick={nextStep}
          disabled={timeTravelIndex < 0 || timeTravelIndex >= timeTravelSteps.length - 1}
          data-testid="time-travel-next"
        >
          下一步
        </button>
        {timeTravelStepId !== null ? (
          <>
            <span className="time-travel-readonly">只读回看</span>
            <button
              type="button"
              className="graph-chip graph-chip-active"
              onClick={exitTimeTravel}
              data-testid="time-travel-live"
            >
              返回实时
            </button>
          </>
        ) : null}
        {timeTravelError !== null ? (
          <span className="time-travel-error" role="alert">
            {timeTravelError}
          </span>
        ) : null}
      </div>
      {view === 'dag' ? (
        <Suspense
          fallback={
            <div className="panel-body">
              <p className="placeholder">正在加载 DAG 视图（React Flow / ELK）…</p>
            </div>
          }
        >
          <DagView />
        </Suspense>
      ) : (
        <TimelineView />
      )}
      {selection !== null ? (
        <TraceDetailCard
          selection={selection}
          policyChanges={policyChanges}
          approvals={approvals}
          onSelectPlugin={requestGraphFocus}
          onSelectStep={(stepId) => {
            select(stepId)
          }}
          onClose={() => {
            select(null)
          }}
        />
      ) : null}
    </section>
  )
}
