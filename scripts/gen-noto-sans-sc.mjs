#!/usr/bin/env node
/**
 * 生成随包中文字体：Noto Sans SC 官方可变字体切片
 * ---------------------------------------------------------------------------
 * 为什么要这一步：Electron 打包后应用不该依赖宿主机字体，否则 Windows 与
 * macOS 的字形/字重/行高不一致，设计系统的排版规范无从落地。Noto Sans SC
 * 是 SIL OFL 1.1 许可（允许随包分发、修改、子集化，且不可撤销），Google
 * Fonts 又提供了按 unicode-range 切好的可变字体切片（100–900 全字重），
 * 因此直接取官方切片随包，无需自研子集化管线。
 *
 * 产出：
 *   apps/desktop/src/renderer/src/assets/fonts/noto-sans-sc.css
 *   apps/desktop/src/renderer/src/assets/fonts/noto-sans-sc/*.woff2  （101 片）
 *
 * 用法：node scripts/gen-noto-sans-sc.mjs
 * 说明：需要能访问 fonts.googleapis.com 与 fonts.gstatic.com。本文件是唯一
 *       生成入口，产物 MUST NOT 手工编辑。
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FONT_DIR = join(ROOT, 'apps/desktop/src/renderer/src/assets/fonts')
const SLICE_DIR = join(FONT_DIR, 'noto-sans-sc')
const CSS_OUT = join(FONT_DIR, 'noto-sans-sc.css')

/** 必须带现代浏览器 UA，否则 Google Fonts 返回 ttf 而非 woff2 切片 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&display=swap'

async function main() {
  console.log('[1/4] 拉取 Google Fonts CSS2 …')
  const cssRes = await fetch(CSS_URL, { headers: { 'User-Agent': UA } })
  if (!cssRes.ok) throw new Error(`CSS 拉取失败：HTTP ${cssRes.status}`)
  const css = await cssRes.text()

  const blocks = [
    ...css.matchAll(/src: url\((https:\/\/[^)]+)\)[^}]*?unicode-range: ([^;]+);/gs),
  ].map(([, url, range]) => ({ url, range: range.trim() }))
  if (blocks.length === 0) throw new Error('CSS 中未解析到任何 @font-face，接口可能已变更')
  console.log(`      解析到 ${blocks.length} 个 @font-face`)

  console.log('[2/4] 下载切片 …')
  await rm(SLICE_DIR, { recursive: true, force: true })
  await mkdir(SLICE_DIR, { recursive: true })

  const records = []
  const CONCURRENCY = 10
  for (let i = 0; i < blocks.length; i += CONCURRENCY) {
    const batch = blocks.slice(i, i + CONCURRENCY)
    const done = await Promise.all(
      batch.map(async (block, k) => {
        const idx = i + k
        const name = `noto-sans-sc-var-${String(idx).padStart(3, '0')}.woff2`
        const res = await fetch(block.url, { headers: { 'User-Agent': UA } })
        if (!res.ok) throw new Error(`切片 ${idx} 下载失败：HTTP ${res.status}`)
        await writeFile(join(SLICE_DIR, name), Buffer.from(await res.arrayBuffer()))
        return { idx, name, range: block.range }
      }),
    )
    records.push(...done)
    process.stdout.write(`      ${records.length}/${blocks.length}\r`)
  }
  console.log()

  console.log('[3/4] 统计体积 …')
  const files = await readdir(SLICE_DIR)
  let total = 0
  for (const f of files) total += (await stat(join(SLICE_DIR, f))).size
  const mib = (total / 1048576).toFixed(2)

  console.log('[4/4] 写出 CSS …')
  const header = `/* ==========================================================================
   Noto Sans SC · 官方可变字体切片随包
   --------------------------------------------------------------------------
   来源：Google Fonts CSS2 API  family=Noto+Sans+SC:wght@100..900
   许可：SIL Open Font License 1.1 —— 允许随包分发 / 修改 / 子集化，且不可撤销
   切片：${files.length} 片，合计 ${total.toLocaleString('en-US')} 字节（${mib} MiB）
   字重：100–900 全轴（可变字体），无需为每个字重单独随包
   机制：按 unicode-range 懒加载；命中哪些片由页面实际出现的字符决定
         —— 本地文件读取，无网络往返；font-display:swap 不阻塞首屏
   生成：scripts/gen-noto-sans-sc.mjs   MUST NOT 手工编辑本文件
   ========================================================================== */
`
  const faces = records
    .map(
      (r) => `
@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('./noto-sans-sc/${r.name}') format('woff2');
  unicode-range: ${r.range};
}`,
    )
    .join('\n')

  await writeFile(CSS_OUT, `${header}${faces}\n`, 'utf8')
  console.log(`\n完成：${files.length} 片 / ${mib} MiB`)
  console.log(`  ${CSS_OUT}`)
}

main().catch((error) => {
  console.error('生成失败：', error.message)
  process.exitCode = 1
})
