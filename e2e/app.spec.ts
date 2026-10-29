import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const desktopDir = path.resolve(__dirname, '../apps/desktop')
const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'))
const electronExecutable = requireFromDesktop('electron') as string
const mainEntry = path.join(desktopDir, 'out', 'main', 'index.js')

const EVENT_SERVER_PORT = 4319

/**
 * 被测进程的环境（U-14）。
 *
 * `ELECTRON_RUN_AS_NODE` 只要存在（取值无关）就会让 electron.exe 退化成纯 Node：
 * `electron.app` 为 undefined、窗口与 DevTools 端口都不出现，Playwright 只会报
 * 含义模糊的 `Process failed to launch!`。IDE / 自动化沙箱常把它塞进环境变量，
 * 所以这里显式清掉，而不是指望调用方的 shell 干净。
 *
 * `DEX_E2E=1` 让 main 在启动期硬失败时走「只打 stderr + 退出」，不弹模态框。
 */
function electronEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DEX_E2E: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * Linux（CI 的 xvfb）没有 GPU：3D 图谱的 WebGL 上下文起不来，`graph-stage` 里
 * 不会有 canvas（首次接入 CI 时实测）。强制 ANGLE 走 SwiftShader 软件渲染；
 * `--enable-unsafe-swiftshader` 是 Chromium 137+ 对软件 WebGL 的新闸。
 * Windows/macOS 本地保持默认（硬件 GL），不改变既有验证行为。
 */
function softwareGlArgs(): string[] {
  return process.platform === 'linux'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : []
}

/**
 * 前置校验：4319 必须空闲。
 *
 * 端口被占时 main 会显式失败退出；但在此之前它是「照常启动」的——
 * 那种情况下被测实例的 renderer 会连上**另一个进程**的 hub，把别人的会话与 trace
 * 当成自己的（U-15）。这里提前给出可读的失败原因，避免又退化成一个超时。
 */
async function assertPortFree(port: number): Promise<void> {
  const occupied = await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => {
      probe.close(() => resolve(false))
    })
    probe.listen(port, '127.0.0.1')
  })
  expect(
    occupied,
    `127.0.0.1:${String(port)} 已被占用：先停掉本机正在运行的 Dex（pnpm dev）再跑 e2e，` +
      '否则被测实例连不上自己的事件通道，会静默继承另一个实例的状态。',
  ).toBe(false)
}

test('应用启动并渲染真实事件流，空闲时不自动生成 Turn', async () => {
  await assertPortFree(EVENT_SERVER_PORT)

  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, ...softwareGlArgs()],
    env: electronEnv(),
  })

  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('panel-session')).toBeVisible({ timeout: 60_000 })
    await expect(window.getByTestId('panel-chat')).toBeVisible()
    await expect(window.getByTestId('chat-input')).toBeVisible()
    await expect(window.getByTestId('composer-controls')).toBeVisible()
    await expect(window.getByTestId('permission-selector')).toBeVisible()
    await expect(window.getByTestId('composer-model-selector')).toBeVisible()
    await expect(window.getByTestId('reasoning-selector')).toBeVisible()
    await expect(window.getByTestId('panel-graph')).toBeVisible()
    await expect(window.getByTestId('graph-stage').locator('canvas')).toBeVisible({
      timeout: 20_000,
    })
    await expect(window.getByTestId('panel-observer')).toBeVisible()
    await expect(window.getByTestId('panel-dag')).toBeVisible()
    await expect(window.getByTestId('observer-tab-dag')).toHaveText('执行流')
    await expect(window.getByTestId('observer-tab-timeline')).toHaveText('时间线')
    // 设置窗自 UI-04 起是**分区模态**（默认分区「运行状态」）：
    // 全局设置要先进「通用设置」分区才挂载——原断言停在「抽屉直出 GlobalSettings」的旧形状上，
    // 自 2026-10-06 起未复跑，D8 接入 CI 时才发现并修正。
    // UI-09 重排后：原始命名空间收进「高级」页；「通用」页是精选条目（不断言其内容）。
    await window.getByTestId('settings-open').click()
    await window.getByTestId('settings-nav-advanced').click()
    const globalSettings = window.getByTestId('global-settings')
    await expect(globalSettings).toBeVisible()
    // 「加载态结束」是硬断言；「加载成功」不是——CI 没有 dsh 宿主，设置读取必然以
    // 可读错误收场（本地有宿主则正常出表单）。这里只要求：要么成功，要么错误有文案，
    // 不允许永远停在「正在读取设置…」。
    await expect(globalSettings.getByText('正在读取设置…')).not.toBeVisible({ timeout: 30_000 })
    const settingsError = globalSettings.locator('.model-error')
    if ((await settingsError.count()) > 0) {
      await expect(settingsError).not.toHaveText('')
    }
    await window.getByTestId('settings-close').click()
    await expect(window.getByTestId('settings-drawer')).not.toBeVisible()
    await window.getByTestId('observer-tab-dag').click()
    await expect(window.getByTestId('panel-dag')).toBeVisible()
    await expect(window.getByTestId('event-count')).toContainText(/[1-9]\d*/, {
      timeout: 30_000,
    })
    await expect(window.getByTestId('turn-count')).toHaveText('Turn 0')

    const shellHeight = await window.evaluate(
      () => document.querySelector('.shell')?.getBoundingClientRect().height ?? 0,
    )
    const titlebarHeight = await window.evaluate(
      () => document.querySelector('[data-testid="titlebar"]')?.getBoundingClientRect().height ?? 0,
    )
    const viewportHeight = await window.evaluate(() => window.innerHeight)
    expect(shellHeight + titlebarHeight).toBeGreaterThanOrEqual(viewportHeight - 1)

    await expect(window.getByTestId('workspace-add')).toBeVisible()
    await expect(window.getByTestId('new-chat')).toHaveCount(0)
    const composerLayout = await window.evaluate(() => {
      const composer = document.querySelector('.composer')
      const selects = [...document.querySelectorAll('.composer-select')]
      return {
        overflow: composer === null ? true : composer.scrollWidth > composer.clientWidth,
        heights: selects.map((node) => Math.round(node.getBoundingClientRect().height)),
        widths: selects.map((node) => Math.round(node.getBoundingClientRect().width)),
      }
    })
    expect(composerLayout.overflow).toBe(false)
    expect(composerLayout.heights.every((height) => height === 28)).toBe(true)
    expect(new Set(composerLayout.widths).size).toBe(1)
  } finally {
    // 断言失败也 MUST 关掉：否则残留实例继续占着 4319，把下一次运行一起带崩。
    await app.close()
  }
})
