#!/usr/bin/env node
/**
 * 导出权威对比度表
 * ---------------------------------------------------------------------------
 * 为什么需要它：设计系统文档里写着的对比度数字，必须和规范页算出来的完全一致，
 * 否则「文档说 4.55、规范页显示 4.57」这种事会反复发生。之前正是因为两处各算各的
 * （文档用 Python 脚本、规范页用浏览器 JS）而漂移了 0.01~0.02。
 *
 * 现在：两者共用 scripts/lib/color.mjs，并且都有一份可复现的落盘产物。
 * 改完 tokens.css 后跑这个脚本，然后按输出更新文档。
 *
 * 产出：brand/contrast.json
 * 用法：node scripts/export-contrast.mjs [--markdown]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildColorTable, CONTRAST_FOREGROUNDS, CONTRAST_SURFACES, contrast } from './lib/color.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = join(ROOT, 'apps/desktop/src/renderer/src/tokens.css')
const OUT = join(ROOT, 'brand/contrast.json')

const AA_TEXT = 4.5
const AA_GRAPHIC = 3.0

/** 给一个对比度值判档：正文达标 / 仅图形达标 / 不达标 */
export function grade(ratio) {
  if (ratio >= AA_TEXT) return 'text'
  if (ratio >= AA_GRAPHIC) return 'graphic'
  return 'fail'
}

async function main() {
  const table = buildColorTable(await readFile(TOKENS, 'utf8'))
  const out = {
    generatedBy: 'scripts/export-contrast.mjs',
    thresholds: { AA_TEXT, AA_GRAPHIC },
    themes: {},
  }

  for (const theme of ['dark', 'light']) {
    const t = table[theme]
    const rows = {}
    for (const fg of CONTRAST_FOREGROUNDS) {
      if (!t[fg]) continue
      const cells = {}
      for (const s of CONTRAST_SURFACES) {
        if (!t[s]) continue
        const r = Number(contrast(t[fg].rgb, t[s].rgb).toFixed(2))
        cells[s.replace('color-surface-', '')] = r
      }
      const entries = Object.entries(cells)
      const tightest = entries.reduce((a, b) => (b[1] < a[1] ? b : a))
      rows[fg] = {
        cells,
        tightest: { on: tightest[0], ratio: tightest[1], grade: grade(tightest[1]) },
      }
    }
    // 特别关注组：实心按钮上的文字、边框
    out.themes[theme] = {
      foregrounds: rows,
      onAccent: Number(
        contrast(t['color-accent-on'].rgb, t['color-accent-primary'].rgb).toFixed(2),
      ),
      borders: Object.fromEntries(
        ['color-border-subtle', 'color-border-default', 'color-border-strong']
          .filter((b) => t[b])
          .map((b) => {
            const cells = {}
            for (const s of CONTRAST_SURFACES) {
              if (!t[s]) continue
              cells[s.replace('color-surface-', '')] = Number(
                contrast(t[b].rgb, t[s].rgb).toFixed(2),
              )
            }
            // 最不利表面必须由数据推出。浅色 border-strong 最不利是 raised（3.09）
            // 而不是 base（3.34）——差 0.25，足以翻转「是否满足 WCAG 1.4.11」的结论。
            const entries = Object.entries(cells)
            const tightest = entries.reduce((a, x) => (x[1] < a[1] ? x : a))
            return [
              b.replace('color-border-', ''),
              {
                cells,
                tightest: { on: tightest[0], ratio: tightest[1] },
                // 1.4.11 只约束「识别控件所必需」的描边；分隔线不受约束，故不打分档
                needs3to1: b === 'color-border-strong',
              },
            ]
          }),
      ),
    }
  }

  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8')

  // ── 控制台报表 ──────────────────────────────────────────────
  for (const theme of ['dark', 'light']) {
    const rows = out.themes[theme].foregrounds
    console.log(`\n${theme.toUpperCase()}  ——  前景 × 表面`)
    console.log(
      '  ' +
        '前景'.padEnd(24) +
        CONTRAST_SURFACES.map((s) => s.replace('color-surface-', '').padStart(9)).join(''),
    )
    console.log(`  ${'-'.repeat(24 + 9 * CONTRAST_SURFACES.length)}`)
    for (const [fg, v] of Object.entries(rows)) {
      const line =
        '  ' +
        fg.replace('color-', '').padEnd(24) +
        CONTRAST_SURFACES.map((s) => {
          const k = s.replace('color-surface-', '')
          const r = v.cells[k]
          if (r === undefined) return '—'.padStart(9)
          const mark = grade(r) === 'text' ? ' ' : grade(r) === 'graphic' ? '~' : 'x'
          return (r.toFixed(2) + mark).padStart(9)
        }).join('')
      console.log(line)
    }
    const t = out.themes[theme]
    console.log(`  accent-on / accent-primary = ${t.onAccent.toFixed(2)}`)
    console.log('  描边 / 各表面（* = 受 1.4.11 约束，需 ≥3.0）')
    for (const [k, v] of Object.entries(t.borders)) {
      const mark = v.needs3to1 ? (v.tightest.ratio >= AA_GRAPHIC ? ' ✓' : ' ✗ 不达标') : ''
      console.log(
        `    ${(k + (v.needs3to1 ? '*' : ' ')).padEnd(9)}最不利 ${v.tightest.on.padEnd(7)}` +
          `${String(v.tightest.ratio).padStart(5)}${mark}`,
      )
    }
  }
  console.log('\n判档：无标记 = ≥4.5 可作正文 · ~ = 3.0–4.5 仅作图形 · x = <3.0 不达标')

  // ── 最紧项汇总（文档要引用的就是这几个数）────────────────────
  console.log('\n最紧项（每个前景对最不利表面）')
  for (const theme of ['dark', 'light']) {
    for (const [fg, v] of Object.entries(out.themes[theme].foregrounds)) {
      console.log(
        `  ${theme.padEnd(5)} ${fg.replace('color-', '').padEnd(22)} ${String(v.tightest.ratio).padStart(5)} on ${v.tightest.on}`,
      )
    }
  }

  console.log(`\n-> ${OUT}`)
}

main().catch((error) => {
  console.error('导出失败：', error.message)
  process.exitCode = 1
})
