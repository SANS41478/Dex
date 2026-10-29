export interface GraphLabelCandidate {
  readonly id: string
  /** 屏幕坐标：节点中心。 */
  readonly x: number
  readonly y: number
  readonly label: string
  /** 选中/悬浮标签即使与已有标签重叠也要保留。 */
  readonly force?: boolean
}

export interface GraphLabelPlacement {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
}

const LABEL_HEIGHT = 20
const LABEL_GAP = 6
const EDGE_PADDING = 12
const MAX_WIDTH = 230
const MIN_WIDTH = 72

function estimateWidth(label: string): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, label.length * 7 + 40))
}

function overlaps(
  left: { x: number; y: number; width: number },
  right: { x: number; y: number; width: number },
): boolean {
  return (
    Math.abs(left.x - right.x) < (left.width + right.width) / 2 + LABEL_GAP &&
    Math.abs(left.y - right.y) < LABEL_HEIGHT + LABEL_GAP
  )
}

/**
 * 贪心放置节点标签：按调用方顺序（选中 → 悬浮 → 连接度）依次尝试，
 * 与已放置标签重叠时跳过；`force` 标签始终保留。
 *
 * 坐标语义：`x/y` 是节点屏幕中心；返回值仍是标签中心（渲染层用 translate 居中）。
 */
export function layoutGraphLabels(
  candidates: readonly GraphLabelCandidate[],
  width: number,
  height: number,
): GraphLabelPlacement[] {
  if (width <= 0 || height <= 0) return []
  const placed: GraphLabelPlacement[] = []
  for (const candidate of candidates) {
    const labelWidth = estimateWidth(candidate.label)
    const x = Math.max(
      EDGE_PADDING + labelWidth / 2,
      Math.min(width - EDGE_PADDING - labelWidth / 2, candidate.x),
    )
    const y = Math.max(EDGE_PADDING + LABEL_HEIGHT, Math.min(height - EDGE_PADDING, candidate.y))
    const next = { id: candidate.id, x, y, width: labelWidth }
    if (candidate.force !== true && placed.some((item) => overlaps(item, next))) continue
    placed.push(next)
  }
  return placed
}
