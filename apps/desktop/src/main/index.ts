import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseSessionStatusNotification } from '@dexagent/bridges'
import { isGraphMessage, isTraceMessage, type ModelSelection, makeMessage } from '@dexagent/shared'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { createBridgeChannel } from './bridge-channel'
import { createDshHost, type DshHostStatus } from './dsh-host'
import { DEX_GRAPH_PORT, prepareDexPatches } from './dsh-patch'
import {
  DEX_DSH_PROFILE,
  ensureDshProfile,
  fallbackDshHome,
  loadDshLocalConfig,
  loadDshProfileSeed,
  readProfileDshVersion,
  resolveDshBin,
  resolveWritableDshHome,
} from './dsh-profile'
import { createEventHub } from './event-hub'
import { startEventServer } from './event-server'
import { createModelControlClient } from './model-control-client'
import { registerModelControlIpc } from './model-control-ipc'
import { probePortFree } from './port-guard'
import { registerSessionIpc } from './session-ipc'
import { registerSnapshotIpc } from './snapshot-ipc'
import { describeRunAsNode } from './startup-guard'
import { registerWindowIpc } from './window-ipc'

/**
 * 启动期环境防御（U-14）：MUST 在任何 `app.*` 调用之前判定。
 * 退化模式下 `electron.app` 是 `undefined`，再往下走只会拿到
 * `Cannot read properties of undefined (reading 'whenReady')` 这种看不懂的栈。
 */
const runAsNodeReason = describeRunAsNode(process.env)
if (runAsNodeReason !== null) {
  console.error(`[dex] 拒绝以 Node 模式启动\n${runAsNodeReason}`)
  process.exit(1)
}

const STARTUP_FAILURE_EXIT_CODE = 1

/**
 * 启动期硬失败：**不静默降级**。
 *
 * 4319 被别的 Dex 实例占着时，renderer 会连上那个进程的 hub 并继承它的状态；
 * 表现成「界面状态一塌糊涂」而不是「启动失败」，事后极难定位（U-15）。
 * 测试场景只看 stderr：原生模态框在无人值守环境里会挂住进程，
 * 让 Playwright 以超时收场，反而比直接退出更难定位。
 */
function reportStartupFailure(error: { code: string; message: string }): void {
  const detail = `${error.code}: ${error.message}`
  if (process.env.DEX_E2E === '1') {
    console.error(`[dex] 启动失败 — ${detail}`)
    app.exit(STARTUP_FAILURE_EXIT_CODE)
    return
  }
  dialog.showErrorBox('Dex 无法启动', `${detail}\n\n请关闭另一个 Dex 实例后重试。`)
  app.exit(STARTUP_FAILURE_EXIT_CODE)
}

let mainWindow: BrowserWindow | null = null

function resolveRepoRoot(): string {
  const candidates = [
    process.env.DEX_REPO_ROOT,
    join(app.getAppPath(), '..', '..'),
    join(app.getAppPath(), '..', '..', '..'),
    process.cwd(),
  ].filter((value): value is string => value !== undefined)
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, 'scripts', 'dsh', 'dex-coding.patch.yml')),
  )
  return found ?? candidates[0] ?? process.cwd()
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0A0A0A',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const rendererTarget =
    !app.isPackaged && devServerUrl !== undefined && devServerUrl !== ''
      ? ({ kind: 'url', url: devServerUrl } as const)
      : ({ kind: 'file', path: join(__dirname, '../renderer/index.html') } as const)
  let loadAttempts = 0
  const loadRenderer = (): void => {
    if (window.isDestroyed()) return
    if (rendererTarget.kind === 'url') void window.loadURL(rendererTarget.url)
    else void window.loadFile(rendererTarget.path)
  }

  // Windows 在开发模式由 IDE / 隐藏终端拉起时，可能把首窗按“最小化”创建；此时
  // isVisible() 仍为 true，10s 兜底会误判为已显示。启动阶段主动还原并聚焦一次。
  let raisedOnStartup = false
  const revealWindow = (): void => {
    if (window.isDestroyed()) return
    const wasMinimized = window.isMinimized()
    if (wasMinimized) window.restore()
    if (!window.isVisible()) window.show()
    if (wasMinimized) console.error('[window] 启动窗口被最小化，已还原并置顶')
    if (!raisedOnStartup) {
      raisedOnStartup = true
      // 后台终端 / 全屏浏览器在前台时，Windows 可能拒绝 focus；短时置顶保证用户能看到启动结果。
      window.setAlwaysOnTop(true)
      setTimeout(() => {
        if (!window.isDestroyed()) window.setAlwaysOnTop(false)
      }, 3_000).unref?.()
    }
    // 从 IDE / 后台终端启动时，Windows 可能拒绝把焦点给 Electron；moveTop 至少保证
    // 窗口不会被全屏浏览器/终端盖住，focus 在允许时再拿到键盘焦点。
    window.moveTop()
    window.focus()
  }
  const startupReveal = setTimeout(revealWindow, 200)
  startupReveal.unref?.()

  /**
   * 加载失败兜底（2026-10-08 实测）：此前窗口用 `show:false` + `ready-to-show` 才显示，
   * 而 Chromium 的 network service 偶发崩溃（`Network service crashed … restarting`）
   * 会让首次加载直接失败——那时既没有窗口、也没有任何日志，用户只看到「软件没出来」。
   * 现在窗口创建即显示（深色底，避免白闪），主帧失败仍最多重试 3 次；10s 兜底保留，
   * 用于异常情况下强制把不可见窗口推出来。
   */
  window.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    // -3 = ERR_ABORTED（导航被新加载取代，如 dev HMR reload），不是故障。
    if (code === -3) return
    console.error(`[window] 渲染页加载失败 code=${String(code)} ${description} url=${validatedURL}`)
    if (loadAttempts < 3) {
      loadAttempts += 1
      setTimeout(loadRenderer, 500 * loadAttempts)
      return
    }
    revealWindow()
  })

  const showFallback = setTimeout(() => {
    if (window.isDestroyed() || (window.isVisible() && !window.isMinimized())) return
    console.error('[window] 首帧 10s 未就绪或窗口被最小化，兜底还原并显示窗口')
    revealWindow()
  }, 10_000)
  showFallback.unref?.()

  window.on('ready-to-show', () => {
    clearTimeout(showFallback)
    revealWindow()
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[window] 渲染进程退出 reason=${details.reason} exitCode=${String(details.exitCode)}`,
    )
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.on('closed', () => {
    clearTimeout(startupReveal)
    clearTimeout(showFallback)
    if (mainWindow === window) mainWindow = null
  })

  loadRenderer()
}

/**
 * 启动期自愈：选一个**真的能写**的 home，再把缺失的 profile 文件补齐。
 *
 * 与原实现的区别（BUGFIX-M4-05）：`ensureDshProfile` 不再抛异常，寻址也不再
 * 「显式档命中即无条件返回」——盘上残留的跨机路径（`C:\Users\user\.dex-dsh`）会被跳过，
 * 落到下一个可写候选；候选链全废时退到系统临时目录，再不济也只报 `missing` 而不崩启动。
 */
function bootstrapDshHome(input: { readonly repoRoot: string }): {
  readonly home: string
  readonly note: string
  /** 选中的 home 是否已有模型凭据；false 时宿主能起来但发消息会报未配置。 */
  readonly credentialReady: boolean
} {
  const localConfig = loadDshLocalConfig({ repoRoot: input.repoRoot })
  const addressInput = {
    env: process.env,
    ...(localConfig.dshHome === undefined ? {} : { localHome: localConfig.dshHome }),
  }
  const resolved = resolveWritableDshHome(addressInput)
  const skippedNote =
    resolved.skipped.length === 0 ? '' : `（跳过不可写候选：${resolved.skipped.join('、')}）`
  // 凭据降级说明：可写但无 `.credentials.yaml` 的候选被让位给带凭据的那个。
  const credentialNote =
    resolved.credentialMissed.length === 0
      ? ''
      : `（因无模型凭据降级：${resolved.credentialMissed.join('、')}）`
  const noteSuffix = `${skippedNote}${credentialNote}`
  const credentialReady = resolved.credentialReady
  if (!credentialReady) {
    console.warn(
      '[dsh-profile] 选中的 home 没有 .credentials.yaml —— 宿主会 ready，但模型调用会报未配置凭据。' +
        '请在界面「设置」里为对应 provider 写入 API key。',
    )
  }

  const seed = loadDshProfileSeed({ repoRoot: input.repoRoot })
  if (seed === null) {
    return {
      home: resolved.home,
      note: `${resolved.home}${noteSuffix} 未读到 scripts/dsh/dex-profile.json，跳过 profile 自愈`,
      credentialReady,
    }
  }

  const outcomes: string[] = []
  for (const home of [resolved.home, fallbackDshHome()]) {
    const { profileDir, created, error } = ensureDshProfile({ home, seed })
    if (error === null) {
      outcomes.push(
        created.length === 0
          ? `profile 已就绪：${profileDir}`
          : `已补写 ${created.join(', ')}：${profileDir}`,
      )
      return { home, note: `${home}${noteSuffix} ${outcomes.join('；')}`, credentialReady }
    }
    outcomes.push(`${home} 不可用（${error.code}）：${error.message}`)
  }

  console.error('[dsh-profile] 所有候选 home 均不可用：')
  for (const line of outcomes) console.error(`[dsh-profile]   ${line}`)
  return {
    home: resolved.home,
    note: `${resolved.home} profile 补齐失败，宿主将以 missing 上报`,
    credentialReady,
  }
}

void app
  .whenReady()
  .then(async () => {
    const disposeWindowIpc = registerWindowIpc(() => mainWindow)
    const hub = createEventHub()
    const demoMode = process.env.DEX_DEMO === '1'
    startEventServer(hub, undefined, {
      demo: demoMode,
      onBindError: (error) => reportStartupFailure(error),
    })

    const repoRoot = resolveRepoRoot()
    const { patchFiles, graphUrl, traceUrl, controlUrl } = prepareDexPatches({ repoRoot })

    // 宿主数据面端口预探测（U-15 同构）：4320 被别的 dsh 宿主占用时，
    // 本进程的 dex-webserver 行不会激活，但 controlUrl/traceUrl 仍会指向 4320——
    // 即指向别人的宿主，静默继承外来会话与 trace 状态。绑不上就在 spawn 前显式失败。
    if (!demoMode) {
      const probe = await probePortFree({ port: DEX_GRAPH_PORT })
      if (!probe.free) {
        reportStartupFailure({
          code: 'DEX_PORT_4320_IN_USE',
          message:
            `图谱/控制通道端口 127.0.0.1:${String(DEX_GRAPH_PORT)} 已被其他进程占用` +
            '（很可能是另一个 dsh 宿主或 Dex 实例）。' +
            '若继续运行，界面会静默连到别人的宿主，因此拒绝启动。请关闭占用该端口的程序后重试。',
        })
        return
      }
    }

    // 宿主寻址自愈：先定可写 home，缺 `dex` profile 就地补上，再按加宽候选链找 CLI。
    // 原先只认「$DSH_HOME/profiles/node_modules」——本机 CLI 装在仓库外的独立工程，
    // 且 `~/.dsh` 下没有 dex profile，宿主会直接 `profile "dex" does not exist` 退出。
    // 寻址失败 MUST NOT 冒泡（那会让 `whenReady` 的 Promise 变成 unhandled rejection，连窗口都建不起来）。
    const { home: dshHome, note: profileNote, credentialReady } = bootstrapDshHome({ repoRoot })
    console.log(`[dsh-profile] ${profileNote}`)
    const localConfig = loadDshLocalConfig({ repoRoot })
    // 版本校验：CLI 必须与 profile 插件同版本，否则新插件 import 老 CLI 不存在的导出，
    // 整棵插件树 fail-loud，症状看着像「插件坏了」实为选错 CLI。期望版本取自 profile 的 `dsh-base`。
    const expectedDshVersion = readProfileDshVersion({ home: dshHome })
    const resolution = resolveDshBin({
      env: process.env,
      home: dshHome,
      localBin: localConfig.dshBin,
      // 仓库内候选兜底（此前漏传，index 与 dsh-host 兜底路径的候选链不一致）。
      repoRoot,
      // profile 名要传进去：首个候选是 `profiles/<profile>/node_modules`——profile 自己装的
      // CLI 才与它的插件同源。共享池里的旧安装（本机是源码仓库符号链接农场）只判版本号挡不住
      // （版本同为 0.1.7-rc.2 但 bundle patch 来自另一个构建），见 BUGFIX-M4-08。
      profile: DEX_DSH_PROFILE,
      ...(expectedDshVersion === null ? {} : { expectedVersion: expectedDshVersion }),
    })
    const dshBin = resolution.bin
    console.log('[dsh-profile] home =', dshHome)
    console.log('[dsh-profile] bin  =', dshBin ?? '（未解析到，宿主将上报 missing）')
    console.log('[dsh-profile] 版本 =', expectedDshVersion ?? '（profile 内无 dsh-base，跳过校验）')
    console.log('[dsh-profile] 凭据 =', credentialReady ? '已配置' : '未配置（模型调用会失败）')
    // 显式档失效（BUGFIX-HOST-01）：用户点名的路径已不存在时不再一票否决整条候选链，
    // 但仍要把这件事说出来——否则用户只会看到「找不到宿主」，无从知道是自己环境变量过期了。
    if (resolution.missingExplicit !== null) {
      console.warn(
        `[dsh-profile] 显式指定的 dsh CLI 已不存在，已跳过并改走候选链：${resolution.missingExplicit}` +
          '（多为残留的 DEX_DSH_BIN 环境变量或 .dex-dsh.local.json 记录：删掉它，或重新指向现装位置）',
      )
    }
    if (resolution.degraded) {
      const known = resolution.versionSkipped
        .map((item) => `${item.bin}（${item.version ?? '版本未知'}）`)
        .join('、')
      console.warn(
        `[dsh-profile] 未找到与 profile 同版本（期望 ${resolution.expectedVersion}）的 dsh CLI，` +
          `降级使用 ${dshBin} —— 插件树很可能因版本错配而加载失败。版本不符：${known}`,
      )
    }

    let hostStatus: DshHostStatus = { phase: 'starting' }
    const host = createDshHost({
      patchFiles,
      home: dshHome,
      ...(dshBin === null ? {} : { binPath: dshBin }),
      ...(expectedDshVersion === null ? {} : { expectedDshVersion }),
      onStatus: (status) => {
        hostStatus = status
        console.log('[dsh-host]', status.phase, status.detail ?? '')
        hub.publish(
          makeMessage('host.status', {
            phase: status.phase,
            ...(status.detail === undefined ? {} : { detail: status.detail }),
          }),
        )
      },
      /**
       * 会话级运行状态（宿主权威）：`agent/status` → SDK `session.status` 通知。
       * 界面「正在执行任务」以它为准，不再靠 `turn.status` 推导——后者一旦丢终态就永久卡住。
       */
      onNotification: (notification) => {
        const status = parseSessionStatusNotification(notification)
        if (status === null) return
        hub.publish(makeMessage('session.status', status))
      },
      log: (line) => {
        console.log(line)
      },
    })
    if (!demoMode) host.start()

    /** 宿主进入终态时给出人话原因：控制请求据此立刻失败而不是空转超时预算。 */
    const describeHostFailure = (): string | null => {
      if (hostStatus.phase === 'missing') {
        return `未找到 dsh 宿主：${hostStatus.detail ?? '未解析到 dsh CLI'}`
      }
      if (hostStatus.phase === 'error') {
        return `dsh 宿主启动失败：${hostStatus.detail ?? '未知原因'}`
      }
      if (hostStatus.phase === 'stopped') return 'dsh 宿主已停止'
      return null
    }

    const channel =
      demoMode || graphUrl === null
        ? null
        : createBridgeChannel({
            url: graphUrl,
            accept: isGraphMessage,
            onMessage: (message) => {
              // 图谱消息统一走 publish：折叠进状态并广播（新客户端拿到新鲜快照）。
              hub.publish(message)
            },
            onState: (state, detail) => {
              console.log('[graph-channel]', state, detail ?? '')
            },
            log: (line) => {
              console.log(line)
            },
          })

    const traceChannel =
      demoMode || traceUrl === null
        ? null
        : createBridgeChannel({
            url: `${traceUrl}${traceUrl.includes('?') ? '&' : '?'}live=1`,
            accept: isTraceMessage,
            onMessage: (message) => {
              // trace 消息走 publish：折叠入规范状态，并从状态回放给后连的 renderer。
              // 不再按「首条 prompt 之后」门控：侧信道连接与 prompt 存在竞态，
              // 门控会把首轮 turn/assistant 消息整段丢掉，表现为“发送成功但没有输出”。
              // renderer 在新建/激活/回放时会清理或替换自己的 trace 状态。
              hub.publish(message)
            },
            onState: (state, detail) => {
              console.log('[trace-channel]', state, detail ?? '')
            },
            log: (line) => {
              console.log(line)
            },
          })

    const modelControl =
      demoMode || controlUrl === null
        ? null
        : createModelControlClient(controlUrl, undefined, { hostFailure: describeHostFailure })
    const disposeModelControlIpc =
      modelControl === null ? () => {} : registerModelControlIpc(modelControl)
    const disposeSessionIpc = registerSessionIpc(host, {
      onPromptStarted: () => {},
      // 停止与续聊都走控制桥（SDK stdio 面没有 cancel，也不能 resume 历史会话）。
      // demoMode / 无控制通道时如实降级：停止报「未提供」，历史会话保持只读回放。
      ...(modelControl === null
        ? {}
        : {
            cancelSession: (sessionId: string) => modelControl.cancelSession(sessionId),
            resumeSession: (input: {
              readonly sessionId: string
              readonly selection?: ModelSelection
            }) => modelControl.resumeSession(input),
            promptViaControl: async (input: {
              readonly sessionId: string
              readonly content: string
            }): Promise<void> => {
              await modelControl.promptSession(input)
            },
          }),
    })
    const disposeSnapshotIpc = registerSnapshotIpc()

    let quitting = false
    app.on('before-quit', (event) => {
      if (quitting) return
      quitting = true
      disposeModelControlIpc()
      disposeSessionIpc()
      disposeSnapshotIpc()
      disposeWindowIpc()
      event.preventDefault()
      channel?.stop()
      traceChannel?.stop()
      void host.stop().finally(() => {
        app.quit()
      })
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error: unknown) => {
    // 顶层兜底：启动期任何未被就地处理的异常都必须留痕并可见，
    // 绝不允许再以 unhandled promise rejection 的形式静默炸掉启动。
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error('[main] 启动失败：', detail)
    const title = 'Dex AGENT 启动失败'
    try {
      dialog.showErrorBox(title, detail)
    } catch {
      /* 无 GUI 会话（如 CI）下弹窗不可用，日志已足够 */
      process.stderr.write(`${title}\n${detail}\n`)
    }
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
