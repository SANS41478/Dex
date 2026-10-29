import { spawn } from 'node:child_process'
import {
  createSdkRequest,
  encodeSdkFrame,
  parseSdkFrame,
  type SdkNotification,
} from '@dexagent/bridges'
import {
  DEX_DSH_PROFILE,
  readProfileDshVersion,
  resolveDshBin,
  resolveWritableDshHome,
} from './dsh-profile'

export { resolveDshBin, resolveDshHome } from './dsh-profile'

export const DSH_PROFILE = DEX_DSH_PROFILE
/**
 * 探活方法：官方 SDK 服务只注册单个分发器，未知方法会回错误响应
 * （实测 `-32603`，README 描述为 `-32601`）——**任一合法响应帧**即证明 stdio 通道已通。
 */
export const DSH_READY_PING_METHOD = 'dex/ping'
/** 启动期探活重试间隔：冷启动（profile 加载 / 链接自愈）可达 10s+，单次 ping 易误判超时。 */
export const DSH_PING_INTERVAL_MS = 2_000
/**
 * Node 运行时 flag（必须放在脚本路径**之前**）：dsh 的 `hmr` 服务依赖
 * `loader.internal`，缺省时它以 `--expose-internals is required for HMR service`
 * 失败退出。没有 HMR，插件启停/配置变更只能「写文件 + 重启」，Dex 的插件管理
 * （UI-10）就无法热生效。
 */
export const DSH_EXPOSE_INTERNALS_FLAG = '--expose-internals'

export type DshHostPhase = 'starting' | 'ready' | 'stopped' | 'error' | 'missing'

export interface DshHostStatus {
  readonly phase: DshHostPhase
  readonly detail?: string
}

/** 窄化的子进程接触面：真实 `spawn` 与测试替身都满足它。 */
export interface DshSpawnedProcess {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly stdin: {
    write(chunk: string): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
  } | null
  readonly stdout: {
    setEncoding(encoding: string): unknown
    on(event: 'data', listener: (chunk: string) => void): unknown
  } | null
  readonly stderr: {
    setEncoding(encoding: string): unknown
    on(event: 'data', listener: (chunk: string) => void): unknown
  } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(): boolean
}

export type DshSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: 'pipe'
    readonly env: NodeJS.ProcessEnv
    readonly windowsHide: boolean
  },
) => DshSpawnedProcess

export interface DshHostOptions {
  readonly onStatus: (status: DshHostStatus) => void
  /**
   * 宿主主动推送的通知帧（`session.event` / `session.status` / `subagent.*`）。
   *
   * 缺省时通知只进日志（原行为）。`session.status` 是「正在执行任务」的唯一权威收尾信号，
   * 必须被消费——早先的实现在这里只有 `log()`，导致界面没有任何会话级运行状态源。
   */
  readonly onNotification?: (frame: SdkNotification) => void
  readonly patchFiles?: readonly string[]
  readonly binPath?: string
  /** 已解析的 dsh home；缺省时按候选链自行解析并跳过不可写候选（见 `resolveWritableDshHome`）。 */
  readonly home?: string
  /**
   * 寻址用的存在性探测（测试注入）；缺省用真实 fs。
   *
   * 为什么必须可注入：寻址的候选链会落到**真实主目录**（`~/.dex-dsh`、`~/.dsh`），
   * 于是「本机恰好装了 dsh」就会让「缺 CLI 时上报 missing」这类用例失效——测试必须能
   * 完全接管「盘上有什么」，否则它测的是这台机器而不是这段代码（2026-10-06 实测踩过）。
   */
  readonly exists?: ((path: string) => boolean) | undefined
  /** 期望的 dsh CLI 版本；缺省时从 profile 内 `dsh-base` 读取（版本校验）。 */
  readonly expectedDshVersion?: string
  readonly nodeBin?: string
  readonly env?: NodeJS.ProcessEnv
  readonly readyTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly spawnFn?: DshSpawnFn
  readonly log?: (line: string) => void
}

export interface DshHost {
  readonly start: () => void
  readonly stop: () => Promise<void>
  readonly isRunning: () => boolean
  readonly request: (method: string, params?: unknown) => Promise<unknown>
}

/** 组装 dsh CLI 参数：`--profile <name>` +（可选）一串 `--patch`（顺序有意义）。 */
export function buildDshArgs(profile = DSH_PROFILE, patchFiles: readonly string[] = []): string[] {
  const args = ['--profile', profile]
  for (const file of patchFiles) args.push('--patch', file)
  return args
}

/**
 * 解析跑 dsh 的 Node 可执行文件：`DEX_NODE_BIN` > 宿主自带的 node > PATH 里的 `node`。
 * Electron main 里 `process.execPath` 是 electron.exe，不能当 Node 用（走 PATH）。
 */
export function resolveNodeBin(input: {
  readonly env: NodeJS.ProcessEnv
  readonly execPath: string
  readonly isElectron: boolean
}): string {
  const override = input.env.DEX_NODE_BIN
  if (override !== undefined && override !== '') return override
  return input.isElectron ? 'node' : input.execPath
}

/** 跨 chunk 的行切分（stdout 是字节流，帧按 `\n` 结束）。 */
export function createLineSplitter(): { push: (chunk: string) => string[] } {
  let carry = ''
  return {
    push(chunk) {
      carry += chunk
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      return lines
    },
  }
}

const defaultSpawn: DshSpawnFn = (command, args, options) =>
  spawn(command, [...args], {
    stdio: options.stdio,
    env: options.env,
    windowsHide: options.windowsHide,
  })

export function createDshHost(options: DshHostOptions): DshHost {
  const spawnFn = options.spawnFn ?? defaultSpawn
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 3_000

  let child: DshSpawnedProcess | null = null
  let stopping = false
  let ready = false
  let readyTimer: NodeJS.Timeout | null = null
  let pingTimer: NodeJS.Timeout | null = null
  let nextRequestId = 10
  const pending = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >()

  const emit = (status: DshHostStatus): void => {
    options.onStatus(status)
  }

  const clearPing = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  const start = (): void => {
    if (child !== null && child.exitCode === null) return

    // 缺省时走**可写**自愈寻址：不可写的显式档会被跳过，否则宿主起来也会因 mkdir EPERM 而失败
    // （BUGFIX-M4-05）。正常路径由 index.ts 传显式 home，这里只是第二道防线。
    const exists = options.exists
    const home =
      options.home ??
      (exists === undefined
        ? resolveWritableDshHome({ env })
        : resolveWritableDshHome({ env, exists })
      ).home
    // 版本校验：CLI 必须与 profile 插件同版本，否则新插件 import 老 CLI 不存在的
    // 导出会让整棵插件树 fail-loud（症状像「插件坏了」，实为选错 CLI）。期望版本取自 profile 的 `dsh-base`。
    const expectedVersion =
      options.expectedDshVersion ??
      (exists === undefined
        ? readProfileDshVersion({ home })
        : readProfileDshVersion({ home, exists })) ??
      undefined
    const resolution = resolveDshBin({
      env,
      home,
      expectedVersion,
      ...(exists === undefined ? {} : { exists }),
    })
    const bin = options.binPath ?? resolution.bin
    // 显式档失效的留痕（BUGFIX-HOST-01）：它已不再阻断候选链，但必须出现在人话原因里，
    // 否则「明明装了宿主却报找不到」这个现场无法从提示反推到那一条过期的环境变量。
    const staleExplicit =
      resolution.missingExplicit === null
        ? ''
        : `；显式指定的 ${resolution.missingExplicit} 已不存在，已跳过`
    if (bin === null) {
      emit({
        phase: 'missing',
        detail: `未找到 dsh CLI（已查 ${home}、本地配置与仓库；可用 DEX_DSH_BIN / DEX_DSH_HOME 覆盖）${staleExplicit}`,
      })
      return
    }
    if (resolution.degraded) {
      const known = resolution.versionSkipped
        .map((item) => `${item.bin}（${item.version ?? '版本未知'}）`)
        .join('、')
      // 不阻断启动（用户可能就是想用别的版本），但必须留痕——否则又会退化成「插件莫名加载失败」。
      console.warn(
        `[dsh-host] 未找到与 profile 同版本（期望 ${resolution.expectedVersion}）的 dsh CLI，` +
          `降级使用 ${bin}。版本不符的候选：${known}`,
      )
    }

    stopping = false
    ready = false
    emit({ phase: 'starting' })

    const nodeBin =
      options.nodeBin ??
      resolveNodeBin({
        env,
        execPath: process.execPath,
        isElectron: process.versions.electron !== undefined,
      })

    // `spawn` 可能**同步**抛出（nodeBin 无效 / 资源耗尽）；此时 `instance.on('error')`
    // 还来不及注册，异常会冒到 `app.whenReady()` 的 Promise 里变成 unhandled rejection。
    // 就地收口成 `error` 终态，让控制请求能立刻拿到人话原因。
    let instance: DshSpawnedProcess
    try {
      instance = spawnFn(
        nodeBin,
        [DSH_EXPOSE_INTERNALS_FLAG, bin, ...buildDshArgs(DSH_PROFILE, options.patchFiles ?? [])],
        {
          stdio: 'pipe',
          // 子进程显式带上解析后的 home（DEX_DSH_HOME 可只影响 dexAgent 的 dsh 宿主），
          // 以及 profile 名——桥接插件要按 `profiles/<profile>/node_modules` 兜底解析
          // `@deepseek-ai/dsh-llm`（dsh 0.2 起依赖装在 profile 自己的 node_modules 下）。
          env: { ...env, DSH_HOME: home, DEX_DSH_PROFILE: DSH_PROFILE },
          windowsHide: true,
        },
      )
    } catch (error) {
      emit({
        phase: 'error',
        detail: `无法启动 dsh 子进程（${nodeBin}）：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    child = instance

    const splitter = createLineSplitter()
    instance.stdout?.setEncoding('utf8')
    instance.stdout?.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        const frame = parseSdkFrame(line)
        if (frame === null) continue
        if (frame.kind === 'response' && frame.frame.id === 1) {
          // 启动期会重试探活，dsh 就绪后可能一次性应答多个 ping；ready 只上报一次。
          if (ready) continue
          ready = true
          clearPing()
          if (readyTimer !== null) clearTimeout(readyTimer)
          emit({ phase: 'ready' })
          continue
        }
        if (frame.kind === 'response') {
          const waiter = pending.get(String(frame.frame.id))
          if (waiter === undefined) {
            log(`[sdk] 未匹配响应 id=${String(frame.frame.id)}`)
            continue
          }
          pending.delete(String(frame.frame.id))
          if (frame.frame.error !== undefined) {
            waiter.reject(new Error(frame.frame.error.message))
          } else {
            waiter.resolve(frame.frame.result)
          }
          continue
        }
        if (frame.kind === 'notification') {
          // 通知走回调（会话状态等），日志保留以便排障；不做 `continue`，
          // 否则接入回调后会静默丢掉这条诊断线索。
          options.onNotification?.(frame.frame)
        }
        log(`[sdk] ${line.trim()}`)
      }
    })
    instance.stderr?.setEncoding('utf8')
    instance.stderr?.on('data', (chunk) => {
      log(`[dsh] ${String(chunk).trimEnd()}`)
    })
    instance.stdin?.on('error', () => {
      /* dsh 退出后写 stdin 会 EPIPE，忽略即可 */
    })

    readyTimer = setTimeout(() => {
      if (!ready && !stopping) emit({ phase: 'error', detail: 'SDK 探活超时（dsh 未响应）' })
    }, readyTimeoutMs)
    readyTimer.unref?.()

    // 冷启动可达 10s+（加载 profile / 自愈链接），单次 ping 会因时序丢失/超时误判；
    // 启动期周期重试，直到收到任一合法响应帧或整体超时。
    const ping = (): void => {
      instance.stdin?.write(encodeSdkFrame(createSdkRequest(1, DSH_READY_PING_METHOD)))
    }
    ping()
    pingTimer = setInterval(() => {
      if (!ready && !stopping) ping()
    }, DSH_PING_INTERVAL_MS)
    pingTimer.unref?.()

    instance.on('exit', (code, signal) => {
      clearPing()
      if (readyTimer !== null) clearTimeout(readyTimer)
      child = null
      for (const waiter of pending.values()) waiter.reject(new Error('dsh 宿主已退出'))
      pending.clear()
      if (stopping || code === 0) {
        emit({ phase: 'stopped' })
        return
      }
      emit({ phase: 'error', detail: `dsh 退出（code=${String(code)} signal=${String(signal)}）` })
    })
    instance.on('error', (error) => {
      clearPing()
      if (readyTimer !== null) clearTimeout(readyTimer)
      child = null
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
      emit({ phase: 'error', detail: error.message })
    })
  }

  const stop = async (): Promise<void> => {
    const instance = child
    if (instance === null || instance.exitCode !== null) return

    stopping = true
    clearPing()
    try {
      instance.stdin?.write(encodeSdkFrame(createSdkRequest(2, 'shutdown')))
    } catch {
      /* 已关闭则走 kill 兜底 */
    }

    const exited = await waitForExit(instance, stopTimeoutMs)
    if (exited) return

    instance.kill()
    if (instance.pid !== undefined && process.platform === 'win32') {
      try {
        spawnFn('taskkill', ['/PID', String(instance.pid), '/T', '/F'], {
          stdio: 'pipe',
          env,
          windowsHide: true,
        })
      } catch {
        /* 兜底失败留给人工清理 */
      }
    }
  }

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const instance = child
    if (instance === null || instance.exitCode !== null) {
      return Promise.reject(new Error('dsh 宿主尚未运行'))
    }
    const id = nextRequestId++
    return new Promise((resolve, reject) => {
      pending.set(String(id), { resolve, reject })
      try {
        instance.stdin?.write(encodeSdkFrame(createSdkRequest(id, method, params)))
      } catch (error) {
        pending.delete(String(id))
        reject(error instanceof Error ? error : new Error('dsh 请求发送失败'))
      }
    })
  }

  return {
    start,
    stop,
    isRunning: () => child !== null && child.exitCode === null,
    request,
  }
}

function waitForExit(instance: DshSpawnedProcess, timeoutMs: number): Promise<boolean> {
  if (instance.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
    instance.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
