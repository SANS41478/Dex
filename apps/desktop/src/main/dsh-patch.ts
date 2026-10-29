import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** dex profile 的图谱侧信道端口（同时出现在渲染出的 patch 与 main 的 WS 客户端里）。 */
export const DEX_GRAPH_PORT = 4320
export const DEX_GRAPH_ROUTE = '/dex-graph'
export const DEX_TRACE_ROUTE = '/dex-trace'
export const DEX_CONTROL_PORT = 4320
export const DEX_CONTROL_ROUTE = '/dex-control'
export const DEX_GRAPH_PORT_PLACEHOLDER = 'DEX_GRAPH_PORT_PLACEHOLDER'
export const DEX_BRIDGE_URL_PLACEHOLDER = 'DEX_BRIDGE_URL_PLACEHOLDER'
export const DEX_TRACE_BUNDLE_URL_PLACEHOLDER = 'DEX_TRACE_BUNDLE_URL_PLACEHOLDER'
export const DEX_MODEL_CONTROL_BUNDLE_URL_PLACEHOLDER = 'DEX_MODEL_CONTROL_BUNDLE_URL_PLACEHOLDER'

export interface DexPatchInput {
  readonly repoRoot: string
  readonly tempDir?: string
  readonly exists?: (path: string) => boolean
  readonly readFile?: (path: string) => string
  readonly writeFile?: (path: string, data: string) => void
  /** 图谱 bundle 覆盖（测试）。 */
  readonly bundlePath?: string
  readonly traceBundlePath?: string
  readonly modelControlBundlePath?: string
}

export interface DexPatchResult {
  /** 传给 dsh 的 `--patch` 文件（顺序有意义）；bundle 不存在时为空。 */
  readonly patchFiles: string[]
  /** 渲染出的图谱 WS URL；bundle 不存在时为 null。 */
  readonly graphUrl: string | null
  /** 渲染出的 trace WS URL；bundle 不存在时为 null。 */
  readonly traceUrl: string | null
  readonly controlUrl: string | null
}

/**
 * 生成运行期 patch（实测结论：`!!js` 不能用于 loader entry 的 `name`）：
 * bundle 缺失时不带对应桥行——插件 import 失败会整树 fail-loud。
 *
 * Rings provider 自 2026-10-07 起**不再经 `--patch` 注入**：
 * patch 的顶层键替换会整体覆盖 `llm-pi-ai.config.providers`，既吞用户自定义
 * provider，又让设置界面的写入被写保护拒绝。现由桥接插件在宿主启动时把 rings
 * 播种进 `llm-pi-ai` 的 user 设置层（`packages/bridges/src/host/rings-profile.ts`）；
 * `DEX_ENABLE_RINGS=0` 改为控制那次播种。
 */
export function prepareDexPatches(input: DexPatchInput): DexPatchResult {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const graphBundlePath =
    input.bundlePath ?? join(input.repoRoot, 'packages', 'bridges', 'dist', 'dex-graph-bridge.mjs')
  const traceBundlePath =
    input.traceBundlePath ??
    join(input.repoRoot, 'packages', 'bridges', 'dist', 'dex-trace-bridge.mjs')
  const modelControlBundlePath =
    input.modelControlBundlePath ??
    join(input.repoRoot, 'packages', 'bridges', 'dist', 'dex-model-control.mjs')
  const hasGraph = exists(graphBundlePath)
  const hasTrace = exists(traceBundlePath)
  const hasControl = exists(modelControlBundlePath)
  if (!hasGraph && !hasTrace && !hasControl) {
    return { patchFiles: [], graphUrl: null, traceUrl: null, controlUrl: null }
  }

  const writeFile =
    input.writeFile ?? ((path: string, data: string) => writeFileSync(path, data, 'utf8'))
  const dir = input.tempDir ?? mkdtempSync(join(tmpdir(), 'dex-dsh-'))

  const webserver = readFile(join(input.repoRoot, 'scripts', 'dsh', 'dex-webserver.patch.yml'))
  const webserverPath = join(dir, 'dex-webserver.patch.yml')
  writeFile(webserverPath, webserver.replaceAll(DEX_GRAPH_PORT_PLACEHOLDER, String(DEX_GRAPH_PORT)))

  const coding = readFile(join(input.repoRoot, 'scripts', 'dsh', 'dex-coding.patch.yml'))
  const codingPath = join(dir, 'dex-coding.patch.yml')
  writeFile(codingPath, coding)

  // 工作区/会话控制面（rename/archive/pin + workspace 管理）：dex profile 原先没有
  // 这三行，桥接层无从调用；组合来源与理由见该 patch 文件头（照 dsh web-app bundle）。
  const management = readFile(join(input.repoRoot, 'scripts', 'dsh', 'dex-management.patch.yml'))
  const managementPath = join(dir, 'dex-management.patch.yml')
  writeFile(managementPath, management)

  const patchFiles = [webserverPath, codingPath, managementPath]

  if (hasGraph) {
    const bridge = readFile(join(input.repoRoot, 'scripts', 'dsh', 'dex-bridge.patch.yml'))
    const bridgePath = join(dir, 'dex-bridge.patch.yml')
    writeFile(
      bridgePath,
      bridge.replaceAll(DEX_BRIDGE_URL_PLACEHOLDER, pathToFileURL(graphBundlePath).href),
    )
    patchFiles.push(bridgePath)
  }

  if (hasTrace) {
    const trace = readFile(join(input.repoRoot, 'scripts', 'dsh', 'dex-trace.patch.yml'))
    const tracePath = join(dir, 'dex-trace.patch.yml')
    writeFile(
      tracePath,
      trace.replaceAll(DEX_TRACE_BUNDLE_URL_PLACEHOLDER, pathToFileURL(traceBundlePath).href),
    )
    patchFiles.push(tracePath)
  }

  if (hasControl) {
    const control = readFile(join(input.repoRoot, 'scripts', 'dsh', 'dex-model-control.patch.yml'))
    const controlPath = join(dir, 'dex-model-control.patch.yml')
    writeFile(
      controlPath,
      control.replaceAll(
        DEX_MODEL_CONTROL_BUNDLE_URL_PLACEHOLDER,
        pathToFileURL(modelControlBundlePath).href,
      ),
    )
    patchFiles.push(controlPath)
  }

  return {
    patchFiles,
    graphUrl: hasGraph ? `ws://127.0.0.1:${DEX_GRAPH_PORT}${DEX_GRAPH_ROUTE}` : null,
    traceUrl: hasTrace ? `ws://127.0.0.1:${DEX_GRAPH_PORT}${DEX_TRACE_ROUTE}` : null,
    controlUrl: hasControl ? `ws://127.0.0.1:${DEX_CONTROL_PORT}${DEX_CONTROL_ROUTE}` : null,
  }
}
