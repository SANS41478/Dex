/**
 * M1-06 基准：500 节点 3D 图谱帧率。
 *
 * 前置：`pnpm dev` 在跑（DEV 构建会注入 window.__dexBench 钩子）。
 * 用法：pnpm bench:graph
 *   BENCH_NODES=800 BENCH_HEADLESS=1 BENCH_URL=http://... 可覆盖。
 * 退出码：达标（avg ≥50fps）0；未达标 1；缺钩子 2。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { resolvePreviewUrl } from './lib/preview-url.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeCount = Number(process.env.BENCH_NODES ?? 500)
const headless = process.env.BENCH_HEADLESS === '1'
const settleMs = Number(process.env.BENCH_SETTLE_MS ?? 3000)
const sampleMs = Number(process.env.BENCH_SAMPLE_MS ?? 5000)
const url = await resolvePreviewUrl(process.env.BENCH_URL)

console.log(`[bench] url=${url} nodes=${nodeCount} headless=${headless}`)

const browser = await chromium.launch({ headless })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.waitForSelector('[data-testid="graph-stage"] canvas', { timeout: 30_000 })

  const seeded = await page.evaluate((count) => {
    const bench = window.__dexBench
    if (!bench) return false
    bench.seedGraph(count)
    return true
  }, nodeCount)
  if (!seeded) {
    console.error('[bench] 未找到 window.__dexBench（请用 pnpm dev 起的 DEV 页面）')
    process.exit(2)
  }

  await page.waitForTimeout(settleMs)

  const result = await page.evaluate(async (durationMs) => {
    const frames = []
    await new Promise((resolve) => {
      let last = performance.now()
      const start = last
      const loop = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (now - start < durationMs) requestAnimationFrame(loop)
        else resolve()
      }
      requestAnimationFrame(loop)
    })
    const total = frames.reduce((sum, value) => sum + value, 0)
    const avgFrameMs = total / frames.length
    const sorted = [...frames].sort((a, b) => a - b)
    return {
      frames: frames.length,
      avgFrameMs,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? avgFrameMs,
      maxFrameMs: Math.max(...frames),
      fps: 1000 / avgFrameMs,
    }
  }, sampleMs)

  const summary = `[bench] ${nodeCount} 节点：avg ${result.fps.toFixed(1)} fps（帧 ${result.avgFrameMs.toFixed(1)}ms · p95 ${result.p95FrameMs.toFixed(1)}ms · max ${result.maxFrameMs.toFixed(1)}ms · 采样 ${result.frames} 帧）`
  console.log(summary)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = join(root, 'artifacts', 'bench')
  mkdirSync(outDir, { recursive: true })
  await page.screenshot({ path: join(outDir, `graph-${stamp}.png`) })
  const outFile = join(outDir, `graph-${stamp}.json`)
  writeFileSync(
    outFile,
    `${JSON.stringify({ url, nodeCount, headless, settleMs, sampleMs, ...result }, null, 2)}\n`,
    'utf8',
  )
  console.log(`[bench] 结果已写入 ${outFile}`)

  if (result.fps < 50) {
    console.error('[bench] 未达标：avg < 50fps')
    process.exit(1)
  }
} finally {
  await browser.close()
}
