#!/usr/bin/env node
/**
 * 从品牌图标资产生成 renderer 可用的 TS 模块
 * ---------------------------------------------------------------------------
 * 事实源是 `brand/icons/*.svg`（设计交付物，24 网格 / 描边 1.75 / 圆头圆角）。
 * 界面上直接用 SVG 需要把图标内联进 DOM，手抄一遍会造成两份定义互相漂移。
 * 因此在这里做一次构建期转换：brand/icons/*.svg → core/icons.generated.ts。
 *
 * 产出：apps/desktop/src/renderer/src/core/icons.generated.ts
 * 用法：node scripts/gen-icons.mjs
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'brand/icons')
const OUT = join(ROOT, 'apps/desktop/src/renderer/src/core/icons.generated.ts')

/** 非图标文件：sprite 与接触印相页 */
const SKIP = new Set(['dex-icons.svg', 'preview.html'])

async function main() {
  const entries = (await readdir(SRC_DIR)).filter((f) => f.endsWith('.svg') && !SKIP.has(f)).sort()
  if (entries.length === 0) throw new Error(`未在 ${SRC_DIR} 找到任何图标`)

  const icons = []
  for (const file of entries) {
    const raw = (await readFile(join(SRC_DIR, file), 'utf8')).trim()
    const name = file.replace(/\.svg$/, '')
    const inner = raw
      .replace(/^<svg[^>]*>/, '')
      .replace(/<\/svg>$/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (inner.length === 0) throw new Error(`${file} 解析后为空`)
    if (/['`$\\]/.test(inner)) throw new Error(`${file} 含需转义字符，请调整生成模板`)
    icons.push({ name, inner })
  }

  const names = icons.map((i) => `  '${i.name}',`).join('\n')
  const map = icons.map((i) => `  '${i.name}': '${i.inner}',`).join('\n')

  const content = `// biome-ignore-all format: 机器生成文件——格式由 scripts/gen-icons.mjs 决定，不由 biome 改写
/* ==========================================================================
   图标路径数据 · 由 scripts/gen-icons.mjs 从 brand/icons/*.svg 生成
   MUST NOT 手工编辑——要改图标请改 brand/icons/ 下的源文件后重跑脚本。
   共 ${icons.length} 个图标，统一规格：24 网格 / 描边 1.75 / 圆头圆角 / 内容区留 2px 内边距。
   ========================================================================== */

export const ICON_NAMES = [
${names}
] as const

export type IconName = (typeof ICON_NAMES)[number]

/** 每个值的形状是 <svg> 的内部标记（不含外层 svg 标签） */
export const ICON_PATHS: Record<IconName, string> = {
${map}
}
`

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, content, 'utf8')
  console.log(`已生成 ${icons.length} 个图标 -> ${OUT}`)
}

main().catch((error) => {
  console.error('生成失败：', error.message)
  process.exitCode = 1
})
