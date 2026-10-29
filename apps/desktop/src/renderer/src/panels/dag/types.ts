import type { Node } from '@xyflow/react'
import type { DagNodeKind, DagStatusTone, DagToolChip } from '../../core/dag-graph'

export interface DexDagNodeData extends Record<string, unknown> {
  kind: DagNodeKind
  label: string
  detail: string
  status: DagStatusTone
  durationMs?: number | undefined
  /** step 节点展开态（选中即展开；再次点击取消选中即收起）。 */
  expanded: boolean
  /** step 节点的工具 chips（展开时渲染，最多 6 个 + 余量提示）。 */
  tools: readonly DagToolChip[]
  /** step 节点展开时的「思考」首句摘要。 */
  thought?: string | undefined
}

export type DexDagNode = Node<DexDagNodeData, 'dex-dag'>
