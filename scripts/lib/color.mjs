/**
 * 颜色工具 · OKLCH → sRGB → WCAG 对比度
 * ---------------------------------------------------------------------------
 * 为什么要有这个模块：同一套换算原本散落在三个脚本里（导出 HEX、生成规范页、
 * 以及当时临时用的 Python 脚本），各自实现必然漂移——事实上已经漂移了 0.01~0.02
 * 的对比度误差，让文档与规范页对不上。现在只留这一份实现，谁要算就 import。
 *
 * 关键约定：对比度必须在 **8-bit 量化后** 计算，因为屏幕最终显示的是量化值。
 * 用浮点直接算会得到「理论上更准、但与实际显示不符」的数字。
 */
import { readFile } from 'node:fs/promises'

/** OKLCH → 线性 sRGB → sRGB（返回 [0,1] 三元组） */
export function oklchToSrgb(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const encode = (x) => {
    const v = Math.min(1, Math.max(0, x))
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }
  return [encode(r), encode(g), encode(bl)]
}

/** [0,1] 三元组 → #RRGGBB */
export const toHex = ([r, g, b]) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase(),
    )
    .join('')}`

/** #RRGGBB → [r,g,b] 0–255 整数 */
export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** WCAG 相对亮度（输入 8-bit 整数三元组） */
export function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度。两个入参都接受 `#RRGGBB` 或 [r,g,b] */
export function contrast(a, b) {
  const toRgb = (x) => (Array.isArray(x) ? x : hexToRgb(x))
  const la = relativeLuminance(toRgb(a))
  const lb = relativeLuminance(toRgb(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 抽取一段 CSS 块里所有 `--color-*: oklch(...)`（跳过带 alpha 的） */
export function extractColors(block) {
  const out = {}
  const re = /--(color-[a-z0-9-]+):\s*oklch\(([^)]+)\)/g
  for (const [, name, args] of block.matchAll(re)) {
    if (args.includes('/')) continue
    const parts = args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
    const L = Number(parts[0].endsWith('%') ? Number(parts[0]) / 100 : parts[0])
    const C = Number(parts[1])
    const H = Number(parts[2])
    if ([L, C, H].some(Number.isNaN)) continue
    const rgb = oklchToSrgb(L, C, H)
    out[name] = { hex: toHex(rgb), rgb: rgb.map((v) => Math.round(v * 255)) }
  }
  return out
}

/** 从一段 CSS 块文本里取某个变量的声明值 */
function _grabVar(css, name) {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+)`))
  return m ? m[1].trim() : null
}

/**
 * 从 tokens.css 抽出两套主题的完整颜色表。
 * 浅色块只写「被覆盖」的 token，其余继承暗色 —— 故用 {...dark, ...light} 合并。
 */
export function buildColorTable(css) {
  const themeAt = css.indexOf('@theme {')
  const darkBody = css.slice(themeAt, css.indexOf('\n}', themeAt))
  // 用带大括号的选择器定位，避免命中文件顶部注释里的那句同名说明
  const lightKey = ":root[data-theme='light'] {"
  const lightAt = css.indexOf(lightKey)
  if (lightAt === -1) throw new Error(`tokens.css 里找不到浅色主题块 ${lightKey}`)
  const lightBody = css.slice(lightAt, css.indexOf('\n}', lightAt))

  const dark = extractColors(darkBody)
  const lightOnly = extractColors(lightBody)
  return { dark, light: { ...dark, ...lightOnly } }
}

/** 读取 tokens.css 并返回颜色表 */
export async function loadColorTable(tokensCssPath) {
  return buildColorTable(await readFile(tokensCssPath, 'utf8'))
}

/** 各主题下需要检查对比度的前景/表面清单（与设计系统文档保持一致） */
export const CONTRAST_FOREGROUNDS = [
  'color-text-primary',
  'color-text-secondary',
  'color-text-tertiary',
  'color-accent-primary',
  'color-status-running',
  'color-status-success',
  'color-status-warning',
  'color-status-failed',
  'color-status-pending',
]

export const CONTRAST_SURFACES = [
  'color-surface-base',
  'color-surface-panel',
  'color-surface-card',
  'color-surface-raised',
  'color-surface-inset',
]

/**
 * 算出完整的对比度矩阵：{ dark: { fg: { surface: ratio } }, light: {...} }
 * 并附一份「每个前景的最紧值」（最小值 = 最不利表面）。
 */
export function contrastMatrix(table) {
  const out = {}
  for (const theme of ['dark', 'light']) {
    const t = table[theme]
    const rows = {}
    for (const fg of CONTRAST_FOREGROUNDS) {
      if (!t[fg]) continue
      rows[fg] = {}
      for (const s of CONTRAST_SURFACES) {
        if (!t[s]) continue
        rows[fg][s.replace('color-', '')] = Number(contrast(t[fg].rgb, t[s].rgb).toFixed(2))
      }
      const vals = Object.values(rows[fg])
      rows[fg].__tightest = Math.min(...vals)
      rows[fg].__tightestOn = Object.keys(rows[fg])
        .filter((k) => !k.startsWith('__'))
        .find((k) => rows[fg][k] === rows[fg].__tightest)
    }
    out[theme] = rows
  }
  return out
}
