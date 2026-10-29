/**
 * 截图自检
 * ---------------------------------------------------------------------------
 * 为什么必须同时跑两套主题：设计系统的绝大多数缺陷只在**其中一套**主题下出现。
 * 已发生过的实例：
 *   - 品牌标志直接放 `mono-white` 位图，浅色主题下白图放白底 → 界面里看不见；
 *   - 状态色「够不够深」只在浅色下踩线（4.47 vs 4.5）。
 * 只截一套主题，等于默认另一套没问题——这不是验证，是假设。
 *
 * 产出：artifacts/screenshots/<时间戳>/<主题>-<视图>.png
 * 用法：pnpm shot            （两套主题）
 *       SHOT_THEME=light pnpm shot
 *       SHOT_URL=http://[::1]:5173 pnpm shot
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { resolvePreviewUrl } from './lib/preview-url.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const url = await resolvePreviewUrl(process.env.SHOT_URL)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = join(root, 'artifacts', 'screenshots', stamp)

/** theme 值与 hooks/useTheme.ts 的 localStorage key / 取值保持一致 */
const THEME_KEY = 'dex-theme'
const requested = process.env.SHOT_THEME ?? 'both'
const themes = requested === 'both' ? ['dark', 'light'] : [requested]
for (const t of themes) {
  if (t !== 'dark' && t !== 'light') {
    console.error(`[shot] SHOT_THEME 只接受 dark / light / both，收到：${t}`)
    process.exit(1)
  }
}

const views = [
  ['full', null],
  ['session', '[data-testid="panel-session"]'],
  ['graph', '[data-testid="panel-graph"]'],
  ['dag', '[data-testid="panel-dag"]'],
]

const browser = await chromium.launch()
mkdirSync(outDir, { recursive: true })
const written = []

/** 在页面脚本运行前写 localStorage，避免首屏用错主题闪一下 */
const primeTheme = (page, theme) =>
  page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [THEME_KEY, theme])

for (const theme of themes) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await primeTheme(page, theme)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  } catch (error) {
    await browser.close()
    console.error(`[shot] 无法访问 ${url}：${error.message}`)
    console.error('[shot] 请先在另一个终端运行 pnpm dev（Electron 提供 WS 数据源），再重试。')
    process.exit(1)
  }

  try {
    await page.waitForSelector('[data-testid="panel-graph"] canvas', { timeout: 15_000 })
  } catch {
    await browser.close()
    console.error('[shot] 页面已打开但三栏未渲染，请检查 renderer 是否有报错。')
    process.exit(1)
  }

  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="event-count"]')
        const graphHeader = document.querySelector('[data-testid="panel-graph"] .panel-header')
        return (
          (el !== null && /[1-9]\d*/.test(el.textContent ?? '')) ||
          (graphHeader !== null && /节点\s+[1-9]\d*/.test(graphHeader.textContent ?? ''))
        )
      },
      undefined,
      { timeout: 20_000 },
    )
  } catch {
    console.warn('[shot] 未等到事件数据（WS 数据源未运行？），仍会截图当前状态。')
  }

  await page.waitForTimeout(2_500)

  // 断言主题真的生效了。截图「看起来是深色」不算证据——可能是系统偏好。
  const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  if (applied !== theme) {
    await browser.close()
    console.error(`[shot] 主题未生效：期望 ${theme}，实际 <html data-theme="${applied}">`)
    process.exit(1)
  }

  for (const [name, selector] of views) {
    if (name === 'dag') {
      const dagTab = page.locator('[data-testid="observer-tab-dag"]')
      if (await dagTab.count()) await dagTab.click()
      await page.waitForSelector('[data-testid="panel-dag"]', { timeout: 10_000 })
      // DagView 是懒加载分包（1.6 MB），且 ELK 布局是异步的。
      // 只等 panel-dag 会截到「正在加载 DAG 视图…」占位——那张图看不到 DAG，等于没截。
      // dag-stage 是 DagView 真正挂载后的稳定锚点。
      try {
        await page.waitForSelector('[data-testid="dag-stage"]', { timeout: 15_000 })
        await page.waitForTimeout(1_200)
      } catch {
        console.warn('[shot] DAG 视图未挂载完成，dag 截图可能仍是加载占位。')
      }
    }
    const file = `${theme}-${name}.png`
    const target = selector ? page.locator(selector) : page
    await target.screenshot({ path: join(outDir, file), timeout: 30_000 })
    written.push(file)
  }

  await page.close()
}

await browser.close()
console.log(`[shot] 已截图到 ${outDir}`)
for (const f of written) console.log(`  ${f}`)
