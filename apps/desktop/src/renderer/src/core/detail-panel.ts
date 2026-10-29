/**
 * 详情面板的尺寸/展开状态（纯函数部分）。
 *
 * 为什么单独抽出来：`.trace-detail` 过去是「固定 320px 宽、max-height 70% 的右下角浮层」，
 * 而时间线正好贴底滚动——最新、最该看的行被自己的详情卡压住。现在详情态改为**坞在观测
 * 面板底部**并允许拖拽调高，尺寸需要对上限做夹取并在刷新后记住。
 */

export const DETAIL_HEIGHT_KEY = 'dex.detail.height.v1'

/** 坞的最小/最大高度（像素）。上限还会被面板可视高度压一次（`clampDetailHeight`）。 */
export const DETAIL_MIN_HEIGHT = 132
export const DETAIL_MAX_HEIGHT = 520

/**
 * 夹取拖拽高度：既受绝对上限，也不能超过可视高度的 `ratio`——
 * 否则在小窗口里详情坞会把画布挤没。
 */
export function clampDetailHeight(value: number, viewportHeight: number, ratio = 0.72): number {
  if (!Number.isFinite(value)) return DETAIL_MIN_HEIGHT
  const ceiling = Math.max(
    DETAIL_MIN_HEIGHT,
    Math.min(DETAIL_MAX_HEIGHT, Math.floor(viewportHeight * ratio)),
  )
  return Math.min(ceiling, Math.max(DETAIL_MIN_HEIGHT, Math.round(value)))
}

export function readDetailHeight(): number {
  try {
    const raw = localStorage.getItem(DETAIL_HEIGHT_KEY)
    if (raw === null) return 240
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clampDetailHeight(parsed, DETAIL_MAX_HEIGHT / 0.72) : 240
  } catch {
    return 240
  }
}

export function writeDetailHeight(value: number): void {
  try {
    localStorage.setItem(DETAIL_HEIGHT_KEY, String(Math.round(value)))
  } catch {
    /* 无存储权限时忽略 */
  }
}

/** 摘要态一行里最该出现的信息：类型 + 名称 + 状态。 */
export function detailTitle(kindLabel: string, name: string): string {
  return name.trim() === '' ? kindLabel : `${kindLabel} · ${name}`
}
