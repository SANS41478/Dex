import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

/**
 * dsh `dex` profile 的寻址与播种（M4-04）。
 *
 * 起因：开屏 `dex.models.list` 报 `connect ECONNREFUSED 127.0.0.1:4320`，其中一条成因是
 * 宿主压根没起来——`~/.dsh` 下没有 `dex` profile 时 dsh 直接 `Error: profile "dex" does not exist`
 * 并以 exit code=1 结束，4320 永远无人监听。本模块把「选一个能用的 home」和「缺 profile 就补上」
 * 收成纯函数，便于单测与复用。
 */

/** dexAgent 专用 dsh home 目录名：不与用户其它 dsh 工具共用，避免互相改写 junction。 */
export const DEFAULT_DSH_HOME_DIRNAME = '.dex-dsh'
/** dsh profile 名（与 `buildDshArgs` 的默认值一致）。 */
export const DEX_DSH_PROFILE = 'dex'
/** profile 内必须有 `package.json` 才被 dsh 认作可用 profile。 */
export const DSH_PROFILE_MANIFEST = 'package.json'
/** dsh 的模型凭据文件名（`$DSH_HOME/.credentials.yaml`，见 `dsh-credentials-local`）。 */
export const DSH_CREDENTIALS_FILENAME = '.credentials.yaml'
/** 本地（不入库）覆盖文件：记录本机 dsh home / CLI 路径。 */
export const LOCAL_CONFIG_FILENAME = '.dex-dsh.local.json'
export const DSH_PROFILE_SEED_RELPATH = join('scripts', 'dsh', 'dex-profile.json')

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value !== ''

export interface DshHomeCandidatesInput {
  readonly env: NodeJS.ProcessEnv
  /**
   * **用户主目录**覆盖（测试用），不是 dsh home 本身。
   *
   * 陷阱：`resolveDshBin` / `resolveWritableDshHome` / `resolveDshHome` 都继承本字段，
   * 而它们的返回值是**具体 home**。把上一级的返回结果当 `home` 回传会被再拼一层
   * （`<home>/.dex-dsh/...`）导致解析必然落空；要传具体 home 请用 `localHome`。
   * 实测踩过：把 `resolveDshHome` 的结果
   * 当主目录传入，`bin` 恒为 null。
   */
  readonly home?: string
  /** 本地配置文件里记录的**具体 home**（不是主目录）。 */
  readonly localHome?: string | undefined
}

/** 显式指定（env / 本地配置）的 home；顺序即优先级。 */
function explicitDshHomes(input: DshHomeCandidatesInput): string[] {
  return [input.env.DSH_HOME, input.env.DEX_DSH_HOME, input.localHome].filter(nonEmpty)
}

/** 所有候选 home：显式指定在前，再是约定目录（`~/.dex-dsh`、`~/.dsh`）。 */
export function listDshHomeCandidates(input: DshHomeCandidatesInput): string[] {
  const userHome = input.home ?? homedir()
  const ordered = [
    ...explicitDshHomes(input),
    join(userHome, DEFAULT_DSH_HOME_DIRNAME),
    join(userHome, '.dsh'),
  ]
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of ordered) {
    const key = resolve(candidate).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

export interface DshProfileProbeInput {
  readonly home: string
  readonly profile?: string | undefined
  readonly exists?: ((path: string) => boolean) | undefined
}

/** 该 home 下是否已有可用的 profile（判据：`profiles/<profile>/package.json` 存在）。 */
export function hasDshProfile(input: DshProfileProbeInput): boolean {
  const exists = input.exists ?? existsSync
  const profile = input.profile ?? DEX_DSH_PROFILE
  return exists(join(input.home, 'profiles', profile, DSH_PROFILE_MANIFEST))
}

export interface HomeCredentialProbeInput {
  readonly home: string
  readonly exists?: ((path: string) => boolean) | undefined
  readonly readFile?: ((path: string) => string) | undefined
}

/**
 * 该 home 根是否已配置**至少一个**模型凭据（`$DSH_HOME/.credentials.yaml` 有非空 `refs`）。
 *
 * 为什么必须单独判：寻址只判「可写 + 有 dex profile」，于是会选中
 * `~/.dex-dsh` 这种**能起来但没凭据**的 home——宿主上报 `ready`、界面显示「运行中」，
 * 一发消息才报未配置凭据。这是「寻址正确但凭据不在同一个 home」的静默失败，
 * 实测中，无凭据 home 必失败。
 */
export function hasAnyCredential(input: HomeCredentialProbeInput): boolean {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const path = join(input.home, DSH_CREDENTIALS_FILENAME)
  if (!exists(path)) return false
  try {
    const raw = readFile(path)
    // 只认 `refs:` 段下形如 `  KEY: <非空值>` 的行；`records:`（授权记录）不算模型凭据。
    let inRefs = false
    for (const line of raw.split('\n')) {
      if (/^[A-Za-z_]+:/.test(line)) {
        inRefs = line.startsWith('refs:')
        continue
      }
      if (inRefs && /^\s+[A-Z0-9_]+:\s*\S/.test(line)) return true
    }
    return false
  } catch {
    return false
  }
}

export interface ResolveDshHomeInput extends DshHomeCandidatesInput {
  readonly exists?: ((path: string) => boolean) | undefined
}

/**
 * 选本次要用的 dsh home。
 *
 * 1. 有显式指定（`DSH_HOME` / `DEX_DSH_HOME` / 本地配置）→ 用第一个，缺失的 profile 交给
 *    `ensureDshProfile` 就地补上（用户已经点名了这个 home）。
 * 2. 没有显式指定 → 优先**已经有 `dex` profile** 的约定目录（本机就是 `~/.dex-dsh`），
 *    都没有时用 `~/.dex-dsh`（dexAgent 专用，避免污染用户其它 dsh 工具的 `~/.dsh`）。
 */
export function resolveDshHome(input: ResolveDshHomeInput): string {
  const exists = input.exists ?? existsSync
  const explicit = explicitDshHomes(input)
  const first = explicit[0]
  if (first !== undefined) return first

  const candidates = listDshHomeCandidates(input)
  const ready = candidates.find((candidate) => hasDshProfile({ home: candidate, exists }))
  return ready ?? candidates[0] ?? join(input.home ?? homedir(), DEFAULT_DSH_HOME_DIRNAME)
}

export interface ResolveDshBinInput extends ResolveDshHomeInput {
  /** 本地配置文件里记录的 CLI 路径。 */
  readonly localBin?: string | undefined
  /** 仓库根（用于发现装进仓库的 dsh，依赖准入）。 */
  readonly repoRoot?: string | undefined
  /**
   * 期望的 dsh 版本（通常是 profile 内 `@deepseek-ai/dsh-base` 的版本）。
   * 提供时 CLI 候选要过版本校验；未提供则退化为「只判存在」（旧行为）。
   */
  readonly expectedVersion?: string | undefined
  /** 要解析的 profile 名（决定「profile 内 CLI」这个首位候选）；缺省为 `dex`。 */
  readonly profile?: string | undefined
  /** 读 package.json 用（测试注入）。 */
  readonly readFile?: ((path: string) => string) | undefined
}

/**
 * home 内 `@deepseek-ai/dsh` 的三个常见落位，**顺序即优先级**：
 *
 * 1. `<home>/profiles/<profile>/node_modules` —— profile **自己**装的 CLI。
 *    MUST 最先：profile 的插件与它在同一次 `pnpm install` 里落盘，是唯一同时满足
 *    「同版本」且「同一份构建」的档位（只判版本，挡不住「版本号相同但构建不同」）。
 * 2. `<home>/profiles/node_modules` —— **共享池**，历史遗留落位。
 *    本机实测（BUGFIX-M4-08）：该池是 2026-09-16 留下的**符号链接农场**，指向源码仓库
 *    `apps/cli`；它不是 dexAgent 装的，是另一次 dsh 安装的残留。放在 profile 内之后，
 *    避免它抢走 CLI 造成「插件来自 npm 安装、bundle patch 来自另一个构建」的错配。
 * 3. `<home>/node_modules` —— 普通 node_modules。
 */
function binCandidatesUnder(root: string, profile: string): string[] {
  const tail = ['@deepseek-ai', 'dsh', 'lib', 'bin.js']
  return [
    join(root, 'profiles', profile, 'node_modules', ...tail),
    join(root, 'profiles', 'node_modules', ...tail),
    join(root, 'node_modules', ...tail),
  ]
}

export interface DshBinResolution {
  /** 最终选用的 CLI 入口（没有任何候选时 `null`）。 */
  readonly bin: string | null
  /** 因**版本不符**被跳过的候选（附各自实际版本），用于日志与排障。 */
  readonly versionSkipped: ReadonlyArray<{ readonly bin: string; readonly version: string | null }>
  /** 期望版本（未提供校准时为 `null`）。 */
  readonly expectedVersion: string | null
  /** 是否发生了「无候选版本匹配、退化为首个存在候选」的降级。 */
  readonly degraded: boolean
  /**
   * 显式档（`DEX_DSH_BIN` / 本地 `dshBin`）**被点名但盘上已不存在**的路径。
   *
   * 非 `null` 表示「用户点名的 CLI 已失效，本次改走了候选链」——上层据此给一句人话提示，
   * 而不是让用户对着一个早已删掉的路径反复怀疑「宿主是不是没装」。
   */
  readonly missingExplicit: string | null
}

/** 读取某个 package.json 的 `version`；任何异常一律返回 `null`（读不出不等于不存在）。 */
export function readPackageVersion(input: {
  readonly packageJsonPath: string
  readonly exists?: ((path: string) => boolean) | undefined
  readonly readFile?: ((path: string) => string) | undefined
}): string | null {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  if (!exists(input.packageJsonPath)) return null
  try {
    const parsed = JSON.parse(readFile(input.packageJsonPath)) as { readonly version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * 读 profile 期望的 dsh 版本：`<home>/profiles/<profile>/node_modules/@deepseek-ai/dsh-base/package.json`。
 *
 * 为什么以 `dsh-base` 为准：profile 的 `dsh.profile.bundles` 首项就是 `@deepseek-ai/dsh-base`，
 * 且所有 `dsh-*` 插件在同一次 `pnpm install` 里被锁到同一版本。CLI 与这些插件必须同版本，
 * 否则新插件 import 老 CLI 不存在的导出符号会让**整棵插件树** fail-loud。
 */
export function readProfileDshVersion(input: {
  readonly home: string
  readonly profile?: string | undefined
  readonly exists?: ((path: string) => boolean) | undefined
  readonly readFile?: ((path: string) => string) | undefined
}): string | null {
  const profile = input.profile ?? DEX_DSH_PROFILE
  return readPackageVersion({
    packageJsonPath: join(
      input.home,
      'profiles',
      profile,
      'node_modules',
      '@deepseek-ai',
      'dsh-base',
      'package.json',
    ),
    ...(input.exists === undefined ? {} : { exists: input.exists }),
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  })
}

/**
 * 解析 dsh CLI 入口，按下列顺序取第一个**可用**的候选：
 * `DEX_DSH_BIN` → 本地配置 `dshBin` → 入参 `home`（已裁决的具体 dsh home）与各约定候选 home 的
 * `profiles/<profile>/node_modules` → `profiles/node_modules` → `node_modules` → 仓库内。
 *
 * `home` 参数语义：**具体 dsh home**，不是用户主目录（与 `DshHomeCandidatesInput.home` 的
 * 「主目录覆盖」不同）。非空时直接作候选首位；缺省时才由 `resolveDshHome` 自行解析。
 * 见 BUGFIX-M4-07（2026-09-28）：语义混用导致 roots 被再拼一层、bin 恒 null。
 *
 * 加宽候选链的原因：本机 CLI 装在仓库外的独立 pnpm 工程（`F:\Deepseek-harness-desktop\dsh-install`），
 * 而 `DSH_HOME` 里并没有它——原来只认「当前 home 的 profiles/node_modules」必然落空。
 *
 * **版本校验**：只判存在是 2026-09-28 那次版本错配的放大器——CLI 是 `0.1.6-alpha.2`
 * 而 profile 插件是 `0.1.7-rc.2`，插件 import 了老 CLI 没有的导出，整树 fail-loud，
 * 症状看着像「插件坏了」实际是选错了 CLI。故当调用方给出 `expectedVersion` 时，**版本不符的候选被跳过**；
 * 显式档（`DEX_DSH_BIN` / 本地 `dshBin`）**不参与版本校验**（尊重用户点名，如实使用）。
 * 全部候选都版本不符时退化为「首个存在候选」并置 `degraded: true`，由上层决定是否告警。
 *
 * **显式档失效即跳过（BUGFIX-HOST-01，2026-10-06）**：显式档的「不校验版本」只解决「用户点名的
 * 版本与 profile 不一致」，不代表「用户点名的路径还在」。原实现在文件不存在时直接返回 `bin: null`
 * 并**结束**——候选链整条被跳过。现场：`DEX_DSH_BIN` 指向已删除的
 * `F:\\Deepseek-harness-desktop\\dsh-install\\…\\bin.js`，而 profile 里明明装着同版本的 CLI，
 * 宿主仍恒报 `missing`（「找不到宿主 dsh 了」）。这与对显式 home 的修正同构：
 * **显式档也要落真实 I/O 检查，不合格就跳过并留痕，而不是替用户判死**。
 * 失效路径记进 `missingExplicit`，由 `index.ts` / `dsh-host.ts` 打印成人话。
 *
 * **profile 内优先（BUGFIX-M4-08，2026-09-29）**：版本校验只比版本号，比不出「版本号相同但构建不同」。
 * 本机现场：`~/.dsh/profiles/node_modules` 是符号链接农场 → 源码仓库 `apps/cli`（版本也是 `0.1.7-rc.2`，
 * 校验通过），而它携带的 bundle patch 来自源码 HEAD（含 `id: otel → @deepseek-ai/dsh-otel`，
 * 该包在 npm 上根本没有 `0.1.7-rc.2`）；偏偏 entry 模块又从 profile 的 npm 安装里解析 →
 * `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-otel` → 整树 fail-loud、进程 exit 1。
 * 故把 `<home>/profiles/<profile>/node_modules` 提到共享池之前：profile 自己装的 CLI 才与它的插件同源。
 */
export function resolveDshBin(input: ResolveDshBinInput): DshBinResolution {
  const exists = input.exists ?? existsSync
  const expectedVersion = nonEmpty(input.expectedVersion) ? input.expectedVersion : null
  const profile = nonEmpty(input.profile) ? input.profile : DEX_DSH_PROFILE
  const versionSkipped: Array<{ bin: string; version: string | null }> = []

  const explicitBin = [input.env.DEX_DSH_BIN, input.localBin].find(nonEmpty)
  // 显式档不校验版本（用户点名了就用它，版本问题由日志呈现而不是替他改道），
  // 但**必须真实存在**才算数：否则一条盘上残留的跨机路径会把整条候选链一起掐掉。
  if (explicitBin !== undefined && exists(explicitBin)) {
    return {
      bin: explicitBin,
      versionSkipped,
      expectedVersion,
      degraded: false,
      missingExplicit: null,
    }
  }
  const missingExplicit = explicitBin ?? null

  // 候选链（加宽）：入参 home → 约定目录 → 仓库内。
  // BUGFIX-M4-07（2026-09-28 排障实测）：入参 home 是**已裁决的具体 dsh home**（bootstrapDshHome /
  // resolveWritableDshHome 的结果），必须直接作首位；绝不能整包透传给 resolveDshHome /
  // listDshHomeCandidates——它们把 home 当**用户主目录**又拼一层（`<home>/.dex-dsh`），
  // roots 全落不存在路径 → bin 恒 null → 宿主上报 missing（现场：`C:\Users\admin\.dsh\.dex-dsh`）。
  // 约定候选一律基于真实主目录展开；localHome 是具体 home 语义，保持透传。
  const roots = [
    nonEmpty(input.home) ? input.home : resolveDshHome(input),
    ...listDshHomeCandidates({
      env: input.env,
      ...(input.localHome === undefined ? {} : { localHome: input.localHome }),
    }),
    input.repoRoot,
  ].filter(nonEmpty)

  const seen = new Set<string>()
  const present: string[] = []
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  for (const root of roots) {
    for (const candidate of binCandidatesUnder(root, profile)) {
      const key = resolve(candidate).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (!exists(candidate)) continue
      present.push(candidate)
      if (expectedVersion === null) {
        return { bin: candidate, versionSkipped, expectedVersion, degraded: false, missingExplicit }
      }
      // CLI 的版本就在它的 package.json 里（bin 是 `…/dsh/lib/bin.js`，包根在上两级）。
      const version = readPackageVersion({
        packageJsonPath: join(dirname(dirname(candidate)), 'package.json'),
        exists,
        readFile,
      })
      if (version === expectedVersion) {
        return { bin: candidate, versionSkipped, expectedVersion, degraded: false, missingExplicit }
      }
      versionSkipped.push({ bin: candidate, version })
    }
  }

  const first = present[0]
  if (first === undefined) {
    return { bin: null, versionSkipped, expectedVersion, degraded: false, missingExplicit }
  }
  // 全都版本不符：退化为首个存在候选（总比 null 好，且上层能从 degraded 感知错配）。
  return {
    bin: first,
    versionSkipped,
    expectedVersion,
    degraded: expectedVersion !== null,
    missingExplicit,
  }
}

const seedSchema = z.object({
  profile: z.string().min(1),
  bundles: z.array(z.string().min(1)).min(1),
  manifestName: z.string().min(1),
  cordis: z.string(),
  cordisPatch: z.string(),
  pnpmWorkspace: z.string(),
})

export type DshProfileSeed = z.infer<typeof seedSchema>

export function parseDshProfileSeed(raw: string): DshProfileSeed {
  return seedSchema.parse(JSON.parse(raw))
}

export interface LoadSeedInput {
  readonly repoRoot: string
  readonly exists?: ((path: string) => boolean) | undefined
  readonly readFile?: ((path: string) => string) | undefined
}

/** 读仓库内的 profile 播种文件；缺失或非法时返回 null（由调用方决定怎么提示）。 */
export function loadDshProfileSeed(input: LoadSeedInput): DshProfileSeed | null {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const path = join(input.repoRoot, DSH_PROFILE_SEED_RELPATH)
  if (!exists(path)) return null
  try {
    return parseDshProfileSeed(readFile(path))
  } catch {
    return null
  }
}

const localConfigSchema = z.object({
  dshHome: z.string().min(1).optional(),
  dshBin: z.string().min(1).optional(),
})

export type DshLocalConfig = z.infer<typeof localConfigSchema>

/**
 * 读本地（gitignore）覆盖配置：本机 dsh home / CLI 路径一次记下，省掉每次启动灌环境变量。
 * 非法内容一律当空配置，不让启动因此挂掉。
 */
export function loadDshLocalConfig(input: LoadSeedInput): DshLocalConfig {
  const exists = input.exists ?? existsSync
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const path = join(input.repoRoot, LOCAL_CONFIG_FILENAME)
  if (!exists(path)) return {}
  try {
    const parsed = localConfigSchema.safeParse(JSON.parse(readFile(path)))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export interface EnsureDshProfileInput {
  readonly home: string
  readonly seed: DshProfileSeed
  readonly exists?: ((path: string) => boolean) | undefined
  readonly mkdir?: ((path: string) => void) | undefined
  readonly writeFile?: ((path: string, data: string) => void) | undefined
  readonly remove?: ((path: string) => void) | undefined
}

/** 结构化失败原因：把裸 fs 错误翻成能定位的信息（哪个 home、哪一级、是不是路径不存在）。 */
export interface DshProfileError {
  /** 原始 fs 错误码（`EPERM` / `EACCES` / `ENOENT` …）。 */
  readonly code: string
  /** 人话原因，含失败路径与排查方向。 */
  readonly message: string
}

export interface EnsureDshProfileResult {
  readonly profileDir: string
  /** 本次真正写入的文件名（已存在的不动）。 */
  readonly created: readonly string[]
  /** 失败原因；成功或无需改动时为 `null`（成功路径 NEVER 抛异常）。 */
  readonly error: DshProfileError | null
}

/**
 * 区分「暂不存在但可建」（正常情形）与「真的建不出来」。
 *
 * 实测结论（2026-09-28，本机 Windows 11 + Node 22）：
 * - 只要进程对**最近的已存在祖先**有写权限，`mkdirSync(recursive)` 会把整条缺失链建出来，
 *   父目录不存在本身 NEVER 报错——`%TEMP%\no-such-user\.dex-dsh\profiles\dex` 正常建成。
 * - `C:\Users\<尚未存在的用户>\…` 报 `EPERM`，且 `C:\Users\__probe_<随机>\` 同样报 `EPERM`，
 *   而 `%TEMP%` 下任意深路径都能建 → 判据是**对 `C:\Users` 没有建子目录的写权限**，
 *   与"路径不存在"无关。
 *
 * 因此判据是「最近的已存在祖先是否可写」，而不是「路径是否存在」。后者会把权限问题
 * 误报成路径问题——那正是首次排障时踩的坑。
 */
function describeFsError(input: {
  readonly error: unknown
  readonly home: string
  readonly target: string
  readonly exists: (path: string) => boolean
}): DshProfileError {
  const code =
    typeof input.error === 'object' && input.error !== null && 'code' in input.error
      ? String((input.error as { readonly code: unknown }).code)
      : 'UNKNOWN'
  const raw = input.error instanceof Error ? input.error.message : String(input.error)

  /** 沿着 home 向上找最近的**已存在**祖先——它就是 mkdir 真正要落笔的地方。 */
  let ancestor = input.home
  for (
    let parent = dirname(ancestor);
    !input.exists(ancestor) && parent !== ancestor;
    parent = dirname(ancestor)
  ) {
    ancestor = parent
  }
  // 祖先存在但本轮没建成 → 权限不足（Windows 的 C:\Users 是典型案例）
  const ancestorExists = input.exists(ancestor)
  const unwritableAncestor = ancestorExists && !input.exists(input.home)

  if (code === 'EPERM' || code === 'EACCES') {
    const hint = unwritableAncestor
      ? `无权在 ${ancestor} 下创建目录——Windows 默认拒绝普通用户在 C:\\Users、C:\\Program Files 等位置新建子目录。` +
        `这是权限问题（不是路径不存在）：把 dshHome 指到当前用户主目录或其它可写位置，或清掉跨机残留的本地配置。`
      : `权限不足或被占用`
    return { code, message: `${hint}（目标 ${input.target}）：${raw}` }
  }
  if (code === 'ENOENT') {
    return { code, message: `${input.target} 所在路径不存在或盘符未挂载：${raw}` }
  }
  return { code, message: `${input.target} 写入失败（${code}）：${raw}` }
}

/**
 * 幂等播种 profile：只补缺失文件，绝不覆盖既有内容（尤其用户手写的 `cordis.patch.yml`）。
 * 失败以 `error` 字段上报而不是抛异常——调用方要能降级到下一个候选 home。
 */
export function ensureDshProfile(input: EnsureDshProfileInput): EnsureDshProfileResult {
  const exists = input.exists ?? existsSync
  const mkdir = input.mkdir ?? ((path: string) => void mkdirSync(path, { recursive: true }))
  const writeFile =
    input.writeFile ?? ((path: string, data: string) => writeFileSync(path, data, 'utf8'))

  const profileDir = join(input.home, 'profiles', input.seed.profile)
  const manifest = {
    name: input.seed.manifestName,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...input.seed.bundles] } },
  }
  const desired: ReadonlyArray<readonly [string, string]> = [
    ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['cordis.yml', input.seed.cordis],
    ['cordis.patch.yml', input.seed.cordisPatch],
    ['pnpm-workspace.yaml', input.seed.pnpmWorkspace],
  ]

  // 先筛出真正缺失的文件：全都齐了就完全不碰磁盘（不 mkdir、不写探针）。
  const missing = desired.filter(([name]) => !exists(join(profileDir, name)))
  if (missing.length === 0) return { profileDir, created: [], error: null }

  // 目录只建一次（原先放在循环里，四个文件会重复调用四次）。
  try {
    mkdir(profileDir)
  } catch (error) {
    return {
      profileDir,
      created: [],
      error: describeFsError({ error, home: input.home, target: profileDir, exists }),
    }
  }

  const created: string[] = []
  for (const [name, content] of missing) {
    const target = join(profileDir, name)
    try {
      writeFile(target, content)
      created.push(name)
    } catch (error) {
      return {
        profileDir,
        created,
        error: describeFsError({ error, home: input.home, target, exists }),
      }
    }
  }
  return { profileDir, created, error: null }
}

export interface CanEnsureDshProfileInput {
  readonly home: string
  readonly exists?: ((path: string) => boolean) | undefined
  readonly mkdir?: ((path: string) => void) | undefined
  readonly writeFile?: ((path: string, data: string) => void) | undefined
  readonly remove?: ((path: string) => void) | undefined
}

/**
 * 探测该 home 是否真的能创建目录并写文件（写一个探针文件再删掉）。
 *
 * 判据必须落在文件 I/O 上而不是 `existsSync`：Windows 上 `existsSync('C:\\Users\\user\\.dex-dsh')`
 * 对不存在的父目录返回 `false`，但 `resolvedHomeCandidates` 的显式档命中即返回，会把这个
 * 不可写路径一路带到 `mkdirSync` 才炸——这正是 BUGFIX-M4-05 的现场。
 */
export function canEnsureDshProfile(input: CanEnsureDshProfileInput): boolean {
  const exists = input.exists ?? existsSync
  const mkdir = input.mkdir ?? ((path: string) => void mkdirSync(path, { recursive: true }))
  const writeFile =
    input.writeFile ?? ((path: string, data: string) => writeFileSync(path, data, 'utf8'))
  const remove = input.remove ?? ((path: string) => void rmSync(path, { force: true }))

  // 已有 profile 的 home 直接算可用：不因探针失败（目录只读但内容齐备）误判成不可用。
  if (hasDshProfile({ home: input.home, exists })) return true

  const probeDir = join(input.home, 'profiles', DEX_DSH_PROFILE)
  const probeFile = join(probeDir, '.dex-probe-write')
  try {
    mkdir(probeDir)
    writeFile(probeFile, '')
  } catch {
    return false
  }
  if (!exists(probeFile)) return false
  try {
    remove(probeFile)
  } catch {
    /* 探针清理失败不影响结论（文件一定会被 ensureDshProfile 的幂等写入覆盖前先判 exists） */
  }
  return true
}

export interface ResolveWritableDshHomeInput extends ResolveDshHomeInput {
  readonly mkdir?: ((path: string) => void) | undefined
  readonly writeFile?: ((path: string, data: string) => void) | undefined
  readonly remove?: ((path: string) => void) | undefined
  readonly readFile?: ((path: string) => string) | undefined
}

export interface ResolvedDshHome {
  /** 最终选用的 home（全部候选都不可写时回退到候选链首位，保持原行为）。 */
  readonly home: string
  /** 被跳过的不可写候选（用于日志；为空表示首位即可用）。 */
  readonly skipped: readonly string[]
  /** 最终选中的 home 是否已配置模型凭据（false 时宿主能起来但模型调用会失败）。 */
  readonly credentialReady: boolean
  /** 因「可写但无凭据」而被降级的候选（仅当存在更好的候选时）。 */
  readonly credentialMissed: readonly string[]
}

/** 平台无关的临时落点：候选链全废时的最后兜底（系统保证可写）。 */
export function fallbackDshHome(tempRoot: string = tmpdir()): string {
  return join(tempRoot, 'dex-dsh')
}

/**
 * 按候选链选 home（自愈核心；凭据一致性）。
 *
 * 判据按序：显式档优先 → 必须可写 → **优先带模型凭据**。
 *
 * 探测策略是**懒的**：先对候选逐个做可写探测，一旦拿到第一个可写候选，
 * 就看它有没有 `.credentials.yaml`——有就立即返回（绝大多数机器到这里就结束，
 * 探测成本与旧实现完全相同）；没有才继续往候选链后面找带凭据的。
 *
 * 为什么需要第三层：dsh 的凭据是 **per-home** 的。若选中的 home 没有凭据文件，
 * 宿主会正常 `ready`、界面显示「运行中」，但一发消息就报未配置——这是
 * 「寻址正确但凭据不在同一个 home」的静默失败。实测对照见
 * 实测中，无凭据 home 必失败。
 */
export function resolveWritableDshHome(input: ResolveWritableDshHomeInput): ResolvedDshHome {
  const exists = input.exists ?? existsSync
  const candidates = listDshHomeCandidates(input)
  const skipped: string[] = []
  const credentialMissed: string[] = []
  const readable = (home: string): boolean =>
    hasAnyCredential({
      home,
      exists,
      ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
    })

  let firstWritable: string | null = null
  for (const candidate of candidates) {
    const ok = canEnsureDshProfile({
      home: candidate,
      exists,
      ...(input.mkdir === undefined ? {} : { mkdir: input.mkdir }),
      ...(input.writeFile === undefined ? {} : { writeFile: input.writeFile }),
      ...(input.remove === undefined ? {} : { remove: input.remove }),
    })
    if (!ok) {
      skipped.push(candidate)
      continue
    }
    // 第一个可写候选：有凭据就直接用它；没凭据则记为「降级待定」，继续找带凭据的。
    if (firstWritable === null) {
      if (readable(candidate)) {
        return { home: candidate, skipped, credentialReady: true, credentialMissed }
      }
      firstWritable = candidate
      continue
    }
    if (readable(candidate)) {
      // 找到带凭据的候选：把此前的无凭据可写候选记为降级原因（解释「为什么不是第一个」）。
      credentialMissed.push(firstWritable)
      return { home: candidate, skipped, credentialReady: true, credentialMissed }
    }
  }

  if (firstWritable !== null) {
    // 可写候选一个都没凭据：仍然用它（宿主可用，只是需要用户去界面里配 key）。
    return { home: firstWritable, skipped, credentialReady: false, credentialMissed }
  }
  return {
    home: candidates[0] ?? join(input.home ?? homedir(), DEFAULT_DSH_HOME_DIRNAME),
    skipped,
    credentialReady: false,
    credentialMissed,
  }
}
