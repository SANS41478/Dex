/**
 * CSS 颜色 → Three.js 可解析的 sRGB hex。
 *
 * 背景：`cssToken()` 返回 `oklch(...)`（CSS Color 4），Three.js `Color.setStyle` 不识别；
 * Chromium 的 canvas `fillStyle` 序列化会保留 `oklch(...)`，因此走「画 1px 再读像素」拿真实 sRGB
 * （实测：`oklch(0.74 0.16 150)` → `#51c672`，与 tokens 导出一致）。
 */
import { cssToken } from './cssToken'

export type ColorProbe = (css: string) => string | null

export interface ColorResolver {
  (css: string): string
  /** 主题切换后必须清空：CSS 变量值变了，缓存不能继续复用旧值。 */
  clear: () => void
}

export function createColorResolver(probe: ColorProbe): ColorResolver {
  const cache = new Map<string, string>()
  const resolve = (css: string): string => {
    const cached = cache.get(css)
    if (cached !== undefined) return cached
    const resolved = probe(css) ?? css
    cache.set(css, resolved)
    return resolved
  }
  resolve.clear = () => {
    cache.clear()
  }
  return resolve
}

/** 默认探针：像素回读；非浏览器环境或无法解析时返回 null（调用方回退原值）。 */
export const canvasColorProbe: ColorProbe = (css) => {
  if (typeof document === 'undefined') return null
  if (css.trim() === '') return null

  const ctx = document.createElement('canvas').getContext('2d')
  if (ctx === null) return null

  ctx.fillStyle = '#000000'
  ctx.fillStyle = css
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const data = ctx.getImageData(0, 0, 1, 1).data
  const [r, g, b, alpha] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
  if (alpha === 0) return null
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

const resolve = createColorResolver(canvasColorProbe)

export function resolveCssColor(css: string): string {
  return resolve(css)
}

/** 主题切换时调用；随后重新 `resolveToken` 才会读到新的 CSS 变量值。 */
export function resetColorCache(): void {
  resolve.clear()
}

/** 语义 token → sRGB hex（先取计算值，再解析为 Three.js 可用的 hex）。 */
export function resolveToken(name: string): string {
  return resolve(cssToken(name))
}
