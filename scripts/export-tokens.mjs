#!/usr/bin/env node
/**
 * 导出 Figma Variables payload
 * ---------------------------------------------------------------------------
 * 把 tokens.css 转成 Figma Variables 插件能吃的两份产物：
 *   artifacts/figma-tokens.setup.json   —— 插件直读的集合 / 模式 / 变量
 *   artifacts/figma-tokens.dtcg.json    —— W3C DTCG 备份（给其它工具用）
 *
 * 命名规则与集合划分沿用现有约定：
 *   --color-surface-base → color/surface/base      集合 Color，模式 Dark / Light
 *   --text-body          → type/body               集合 Type
 *   --radius-md          → radius/md               集合 Radius
 *   --spacing-4          → spacing/4               集合 Spacing
 *   --shadow-md          → shadow/md               集合 Shadow，模式 Dark / Light
 *   --icon-md            → size/icon/md            集合 Size
 *
 * 为什么不再用 Playwright 换算颜色：上一版靠浏览器 canvas 解析色值，遇到
 * `var(--color-surface-base)` 这类别名声就直接抛错（canvas 没有 CSS 上下文）。
 * 现在改用 scripts/lib/color.mjs 在 Node 端算，与文档、规范页共用同一实现。
 *
 * 用法：node scripts/export-tokens.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { oklchToSrgb, toHex } from './lib/color.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = join(ROOT, 'apps/desktop/src/renderer/src/tokens.css')
const OUT_DIR = join(ROOT, 'artifacts')
const COLLECTION_NAME = process.env.FIGMA_TOKEN_COLLECTION ?? 'Dex Tokens'

const css = readFileSync(TOKENS, 'utf8')

/** 取出一个 CSS 块的文本体 */
function block(selector) {
  const at = css.indexOf(selector)
  if (at === -1) throw new Error(`tokens.css 里找不到 ${selector}`)
  return css.slice(at, css.indexOf('\n}', at))
}

/** 解析一个块里的所有声明，返回 Map<name, value>（保留出现顺序） */
function declarations(text) {
  const out = new Map()
  for (const [, name, value] of text.matchAll(/^\s*--([a-z0-9-]+):\s*(.+?);\s*$/gm)) {
    out.set(`--${name}`, value.trim())
  }
  return out
}

const darkBlock = block('@theme {')
const rootBlock = block('\n:root {')
const lightBlock = block(":root[data-theme='light'] {")

const darkColors = declarations(darkBlock)
const lightColors = declarations(lightBlock)
// 尺度类 token 分居两块：radius / text / font 在 @theme，spacing / shadow / icon 在 :root —— 必须合并
const scales = new Map([...declarations(darkBlock), ...declarations(rootBlock)])

const skipped = []

/** 把 CSS 颜色字面量转成 Figma 的 hex（带 alpha 时输出 8 位） */
function toFigmaColor(name, value) {
  const oklch = value.match(
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/i,
  )
  if (oklch) {
    const L = Number(oklch[1].endsWith('%') ? Number.parseFloat(oklch[1]) / 100 : oklch[1])
    const C = Number(oklch[2])
    const H = Number(oklch[3])
    const alpha =
      oklch[4] === undefined
        ? 1
        : Number(oklch[4].endsWith('%') ? Number.parseFloat(oklch[4]) / 100 : oklch[4])
    const hex = toHex(oklchToSrgb(L, C, H))
    return alpha >= 1
      ? hex
      : hex +
          Math.round(alpha * 255)
            .toString(16)
            .padStart(2, '0')
            .toUpperCase()
  }
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value.toUpperCase()
  // var() 别名、color-mix() 派生色：Figma 变量无法表达，交给 Figma 端用变量引用处理
  const reason = value.startsWith('var(')
    ? 'var() 别名'
    : value.startsWith('color-mix(')
      ? 'color-mix() 派生'
      : '非颜色值'
  skipped.push({ name, value, reason })
  return null
}

/** CSS 变量名 → Figma 变量名（斜杠分组） */
function figmaName(cssName) {
  const n = cssName.replace(/^--/, '')
  if (n.startsWith('color-'))
    return (
      'color/' +
      n
        .slice('color-'.length)
        .replace(/-/g, '/')
        .replace(/\/\d+$/, (m) => m)
    )
  if (n.startsWith('text-')) return `type/${n.slice('text-'.length)}`
  if (n.startsWith('radius-')) return `radius/${n.slice('radius-'.length)}`
  if (n.startsWith('spacing-')) return `spacing/${n.slice('spacing-'.length)}`
  if (n.startsWith('shadow-')) return `shadow/${n.slice('shadow-'.length)}`
  if (n.startsWith('icon-')) return `size/icon/${n.slice('icon-'.length)}`
  return null
}

const collections = new Map()
function put(collection, modes, token) {
  if (!collections.has(collection))
    collections.set(collection, { name: collection, modes, tokens: [] })
  collections.get(collection).tokens.push(token)
}

// ── Color：两套主题同构，值按模式给 ─────────────────────────────────
for (const [name, value] of darkColors) {
  if (!name.startsWith('--color-')) continue // @theme 里还混着 radius/text/spacing 等尺度 token
  const figma = figmaName(name)
  if (!figma) continue
  const dark = toFigmaColor(name, value)
  if (dark === null) continue
  const lightRaw = lightColors.get(name)
  const light = lightRaw ? toFigmaColor(name, lightRaw) : dark
  put('Color', ['Dark', 'Light'], {
    name: figma,
    resolvedType: 'COLOR',
    values: { Dark: dark, Light: light ?? dark },
    description: `tokens.css ${name}`,
  })
}

// ── Type：字号 + 行高（10 组）与字体族 ───────────────────────────────
for (const [name, value] of scales) {
  if (name.startsWith('--font-sans') || name.startsWith('--font-mono')) {
    const leaf = name.replace('--font-', '')
    // 多行字体栈：压平空白，Figma 里是一整串 fontFamily
    put('Type', ['Default'], {
      name: `type/font/${leaf}`,
      resolvedType: 'STRING',
      values: { Default: value.replace(/\s+/g, ' ').trim() },
      description: `tokens.css ${name}`,
    })
    continue
  }
  const size = name.match(/^--text-(.+?)(--line-height)?$/)
  if (!size) continue
  const base = figmaName(`--text-${size[1]}`)
  if (!base) continue
  const num = Number.parseFloat(value)
  if (Number.isNaN(num)) continue
  put('Type', ['Default'], {
    name: size[2] ? `${base}/line-height` : base,
    resolvedType: 'FLOAT',
    values: { Default: num },
    description: `tokens.css ${name}`,
  })
}

// ── 单一模式的尺度类：Radius / Spacing / Size ───────────────────────
for (const [name, value] of scales) {
  const figma = figmaName(name)
  if (!figma) continue
  const num = Number.parseFloat(value)
  if (Number.isNaN(num)) continue
  if (name.startsWith('--radius-')) {
    put('Radius', ['Default'], {
      name: figma,
      resolvedType: 'FLOAT',
      values: { Default: num },
      description: `tokens.css ${name}`,
    })
  } else if (name.startsWith('--spacing-')) {
    put('Spacing', ['Default'], {
      name: figma,
      resolvedType: 'FLOAT',
      values: { Default: num },
      description: `tokens.css ${name}`,
    })
  } else if (name.startsWith('--icon-')) {
    put('Size', ['Default'], {
      name: figma,
      resolvedType: 'FLOAT',
      values: { Default: num },
      description: `tokens.css ${name}`,
    })
  }
}

// ── Shadow：两套主题，值是 CSS 字符串（Figma 端按需替换为 Effect Style）──
const darkShadows = new Map()
const lightShadows = new Map()
for (const [name, value] of scales) if (name.startsWith('--shadow-')) darkShadows.set(name, value)
for (const [name, value] of declarations(lightBlock))
  if (name.startsWith('--shadow-')) lightShadows.set(name, value)
for (const [name, value] of darkShadows) {
  const figma = figmaName(name)
  if (!figma) continue
  put('Shadow', ['Dark', 'Light'], {
    name: figma,
    resolvedType: 'STRING',
    values: { Dark: value, Light: lightShadows.get(name) ?? value },
    description: `tokens.css ${name}`,
  })
}

// ── 输出 ───────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true })

const setup = {
  collectionName: COLLECTION_NAME,
  collections: [...collections.values()].map((c) => ({
    name: c.name,
    modes: c.modes,
    tokens: c.tokens,
  })),
}
// 兼容旧插件的扁平结构（单集合时）
setup.tokens = setup.collections.flatMap((c) => c.tokens)

// DTCG 备份：同名多模式写进 $extensions.modes
const dtcg = {}
for (const c of collections.values()) {
  if (!dtcg[c.name]) dtcg[c.name] = {}
  for (const t of c.tokens) {
    const segments = t.name.split('/')
    let node = dtcg[c.name]
    for (const s of segments.slice(0, -1)) {
      if (!node[s]) node[s] = {}
      node = node[s]
    }
    const leaf = segments.at(-1)
    const dtcgType =
      t.resolvedType === 'COLOR' ? 'color' : t.resolvedType === 'FLOAT' ? 'dimension' : 'string'
    const entry = { $type: dtcgType, $value: t.values[c.modes[0]], $description: t.description }
    if (Object.keys(t.values).length > 1) entry.$extensions = { modes: t.values }
    node[leaf] = entry
  }
}

const setupPath = join(OUT_DIR, 'figma-tokens.setup.json')
const dtcgPath = join(OUT_DIR, 'figma-tokens.dtcg.json')
writeFileSync(setupPath, `${JSON.stringify(setup, null, 2)}\n`)
writeFileSync(dtcgPath, `${JSON.stringify(dtcg, null, 2)}\n`)

console.log('[tokens] 集合与变量数：')
for (const c of collections.values()) {
  console.log(`  ${c.name.padEnd(9)} 模式 ${c.modes.join('/').padEnd(14)} ${c.tokens.length} 个`)
}
console.log(`[tokens] -> ${setupPath}`)
console.log(`[tokens] -> ${dtcgPath}`)
if (skipped.length > 0) {
  console.log(`\n[tokens] 跳过 ${skipped.length} 个无法表达为 Figma 变量的 token：`)
  for (const s of skipped) console.log(`  ${s.name.padEnd(34)} ${s.reason}`)
  console.log('  （这些由 Figma 端用变量引用或效果样式还原，不导入）')
}
