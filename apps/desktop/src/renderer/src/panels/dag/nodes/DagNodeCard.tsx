import { Handle, type NodeProps, Position } from '@xyflow/react'
import { toneClass } from '../../../core/timeline'
import { useTraceSelectionStore } from '../../../stores/traceSelectionStore'
import type { DexDagNode } from '../types'

const KIND_LABELS = {
  turn: '轮次',
  step: '步骤',
  tool: '工具',
} as const

const MAX_VISIBLE_CHIPS = 6

export function DagNodeCard({ id, data }: NodeProps<DexDagNode>) {
  const selected = useTraceSelectionStore((state) => state.selectedId === id)
  const visibleTools = data.expanded ? data.tools.slice(0, MAX_VISIBLE_CHIPS) : []
  const hiddenCount = data.tools.length - visibleTools.length

  return (
    <div
      className={`dag-node dag-node-${data.kind} dag-tone-${data.status}${
        selected ? ' dag-node-selected' : ''
      }`}
      data-node-id={id}
    >
      {/* 自定义节点必须显式提供连接点，React Flow 才能挂接边 */}
      <Handle type="target" position={Position.Left} className="dag-handle" />
      <div className="dag-node-head">
        <span className="dag-node-kind">{KIND_LABELS[data.kind]}</span>
        <span className="dag-node-label mono">{data.label}</span>
        {data.durationMs !== undefined ? (
          <span className="dag-node-badge mono">{data.durationMs}ms</span>
        ) : null}
      </div>
      <div className="dag-node-detail">{data.detail}</div>
      {data.expanded && data.thought !== undefined ? (
        <div className="dag-node-thought" data-testid="dag-node-thought">
          <span className="dag-node-thought-tag">思考</span>
          <span className="dag-node-thought-text">{data.thought}</span>
        </div>
      ) : null}
      {visibleTools.length > 0 ? (
        <div className="dag-node-tools" data-testid="dag-node-tools">
          {visibleTools.map((tool, index) => (
            <span
              key={`${tool.label}-${String(index)}`}
              className={`chip chip-${toneClass(tool.tone)}`}
            >
              {tool.label}
            </span>
          ))}
          {hiddenCount > 0 ? <span className="chip chip-more">+{hiddenCount}</span> : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="dag-handle" />
    </div>
  )
}
