import type { NodeStatus, PluginType } from '@dexagent/shared'
import { STATUS_LABELS, TYPE_LABELS } from './labels'

export interface GraphLabelView {
  readonly id: string
  readonly label: string
  readonly type: PluginType
  readonly status: NodeStatus
  readonly x: number
  readonly y: number
  readonly selected: boolean
}

export function GraphLabels({ labels }: { readonly labels: readonly GraphLabelView[] }) {
  if (labels.length === 0) return null
  return (
    <div className="graph-labels" aria-hidden="true" data-testid="graph-labels">
      {labels.map((label) => (
        <span
          key={label.id}
          className={`graph-node-label${label.selected ? ' graph-node-label-selected' : ''}`}
          style={{ left: label.x, top: label.y }}
        >
          <span
            className={`graph-type-dot graph-type-${label.type}`}
            title={TYPE_LABELS[label.type]}
          />
          <span className="graph-node-label-text">{label.label}</span>
          <span
            className={`graph-status-ring graph-status-ring-${label.status}`}
            title={STATUS_LABELS[label.status]}
          />
        </span>
      ))}
    </div>
  )
}
