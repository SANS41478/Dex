#!/usr/bin/env node
/**
 * 把 tokens.css 里的 OKLCH 颜色导出为「OKLCH + HEX」双份对照表
 * ---------------------------------------------------------------------------
 * 为什么需要它：设计稿、对外物料、Figma、第三方工具大多只认 HEX；而代码里
 * 用 OKLCH 推导明暗系列更准确。两者必须是同一份事实源的两种表示，否则会漂移。
 * 因此从 tokens.css 单向生成，任何手工改过的 HEX 都会被覆盖。
 *
 * 产出：brand/tokens-hex.json
 * 用法：node scripts/export-token-hex.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractColors } from './lib/color.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = join(ROOT, 'apps/desktop/src/renderer/src/tokens.css')
const OUT = join(ROOT, 'brand/tokens-hex.json')

async function main() {
  const css = await readFile(CSS, 'utf8')

  // 暗色：@theme { ... } —— 取第一个大括号块
  const themeStart = css.indexOf('@theme {')
  const themeBody = css.slice(themeStart, css.indexOf('\n}', themeStart))
  // 浅色：:root[data-theme='light'] { ... }
  const lightKey = ":root[data-theme='light'] {"
  const lightStart = css.indexOf(lightKey)
  const lightBody = css.slice(lightStart, css.indexOf('\n}', lightStart))

  const dark = extractColors(themeBody)
  const light = extractColors(lightBody)

  const out = { dark, light }
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8')

  console.log(
    `暗色 ${Object.keys(dark).length} 个 · 浅色 ${Object.keys(light).length} 个 -> ${OUT}`,
  )
  const onlyDark = Object.keys(dark).filter((k) => !(k in light))
  if (onlyDark.length > 0) console.log(`仅暗色定义（浅色会继承 @theme 值）: ${onlyDark.join(', ')}`)
}

main().catch((error) => {
  console.error('导出失败：', error.message)
  process.exitCode = 1
})
