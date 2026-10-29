import type { NodeStatus, PluginType } from '@dexagent/shared'
import { STATUS_LABELS, TYPE_LABELS, TYPE_ORDER } from './labels'

const STATUS_ORDER: readonly NodeStatus[] = ['active', 'inactive', 'error']

export function GraphLegend({
  motionEnabled,
  reducedMotion,
}: {
  readonly motionEnabled: boolean
  readonly reducedMotion: boolean
}) {
  return (
    <div className="graph-legend" data-testid="graph-legend">
      <span className="graph-legend-group">
        <span className="graph-legend-title">类型</span>
        {TYPE_ORDER.map((type: PluginType) => (
          <span className="graph-legend-item" key={type}>
            <span className={`graph-type-dot graph-type-${type}`} />
            {TYPE_LABELS[type]}
          </span>
        ))}
      </span>
      <span className="graph-legend-group">
        <span className="graph-legend-title">状态</span>
        {STATUS_ORDER.map((status) => (
          <span className="graph-legend-item" key={status}>
            <span className={`graph-status-ring graph-status-ring-${status}`} />
            {STATUS_LABELS[status]}
          </span>
        ))}
      </span>
      <span className="graph-legend-hint">
        {motionEnabled && !reducedMotion ? '呼吸 · 依赖流光' : '静息'}
      </span>
    </div>
  )
}
