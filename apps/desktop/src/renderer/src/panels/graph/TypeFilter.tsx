import type { PluginType } from '@dexagent/shared'
import { TYPE_LABELS, TYPE_ORDER } from './labels'

export interface TypeFilterProps {
  readonly counts: Readonly<Record<PluginType, number>>
  readonly visible: ReadonlySet<PluginType>
  readonly onToggle: (type: PluginType) => void
  readonly onReset: () => void
}

export function TypeFilter({ counts, visible, onToggle, onReset }: TypeFilterProps) {
  const hidden = TYPE_ORDER.filter((type) => !visible.has(type)).length

  return (
    <div className="graph-chips" data-testid="graph-type-filter">
      {TYPE_ORDER.map((type) => (
        <button
          key={type}
          type="button"
          className={`graph-chip${visible.has(type) ? ' graph-chip-active' : ''}`}
          aria-pressed={visible.has(type)}
          onClick={() => {
            onToggle(type)
          }}
        >
          <span className={`graph-type-dot graph-type-${type}`} />
          {TYPE_LABELS[type]}
          <span className="graph-chip-count">{counts[type] ?? 0}</span>
        </button>
      ))}
      {hidden > 0 ? (
        <button type="button" className="graph-chip graph-chip-reset" onClick={onReset}>
          重置过滤
        </button>
      ) : null}
    </div>
  )
}
