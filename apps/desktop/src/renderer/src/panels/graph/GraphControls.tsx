import type { PluginType } from '@dexagent/shared'
import { useState } from 'react'
import { TypeFilter } from './TypeFilter'

export interface GraphControlsProps {
  readonly counts: Readonly<Record<PluginType, number>>
  readonly visible: ReadonlySet<PluginType>
  readonly onToggle: (type: PluginType) => void
  readonly onReset: () => void
  readonly onSearch: (query: string) => boolean
  readonly onExportJson: () => void
  readonly onExportPng: () => void
  readonly motionEnabled: boolean
  readonly onToggleMotion: () => void
  readonly exportFeedback?: string | null
}

export function GraphControls({
  counts,
  visible,
  onToggle,
  onReset,
  onSearch,
  onExportJson,
  onExportPng,
  motionEnabled,
  onToggleMotion,
  exportFeedback,
}: GraphControlsProps) {
  const [query, setQuery] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  return (
    <div className="graph-toolbar" data-testid="graph-toolbar">
      <form
        className="graph-search"
        onSubmit={(event) => {
          event.preventDefault()
          const found = onSearch(query)
          setFeedback(found ? null : '未找到匹配节点')
        }}
      >
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setFeedback(null)
          }}
          placeholder="搜索节点（label / id / 模块名）"
          aria-label="搜索节点"
        />
        <button type="submit">定位</button>
        {feedback !== null ? <span className="graph-search-feedback">{feedback}</span> : null}
      </form>
      <TypeFilter counts={counts} visible={visible} onToggle={onToggle} onReset={onReset} />
      <div className="graph-export-actions">
        <button type="button" className="graph-chip" onClick={onExportJson}>
          导出 JSON
        </button>
        <button type="button" className="graph-chip" onClick={onExportPng}>
          导出 PNG
        </button>
        <button
          type="button"
          className={`graph-chip${motionEnabled ? ' graph-chip-active' : ''}`}
          aria-pressed={motionEnabled}
          onClick={onToggleMotion}
          data-testid="graph-motion-toggle"
        >
          呼吸动效
        </button>
      </div>
      {exportFeedback !== undefined && exportFeedback !== null ? (
        <span className="graph-search-feedback">{exportFeedback}</span>
      ) : null}
    </div>
  )
}
