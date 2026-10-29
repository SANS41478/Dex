/**
 * 幂等引导 dsh `dex` profile（M1-04a；M4-04 起内容改从 `scripts/dsh/dex-profile.json` 读，
 * 与 `apps/desktop/src/main/dsh-profile.ts` 的启动自愈共用同一份事实源）。
 *
 * 只在缺失时写文件，不触碰既有 profile（尤其用户的 web profile）。
 *
 * 用法：
 *   node scripts/setup-dsh-profile.mjs                       # 按候选链选 home 并补 profile
 *   node scripts/setup-dsh-profile.mjs --home C:\x\.dex-dsh  # 指定 home
 *   node scripts/setup-dsh-profile.mjs --bin F:\dsh\...\bin.js
 *       # 顺带把 home 与 CLI 路径写进 .dex-dsh.local.json（gitignore），
 *       # 之后启动应用不再需要每次灌 DEX_DSH_HOME / DEX_DSH_BIN
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_CONFIG_FILENAME = '.dex-dsh.local.json'

const readArg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** 读某个 package.json 的 `version`；读不出返回 null（读不出 ≠ 不存在）。 */
const readPackageVersion = (packageJsonPath) => {
  if (!existsSync(packageJsonPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    return null
  }
}

const seed = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'dsh', 'dex-profile.json'), 'utf8'))
const localConfigPath = join(repoRoot, LOCAL_CONFIG_FILENAME)
const localConfig = existsSync(localConfigPath)
  ? JSON.parse(readFileSync(localConfigPath, 'utf8'))
  : {}

const profile = readArg('--profile') ?? seed.profile
const candidates = [
  process.env.DSH_HOME,
  process.env.DEX_DSH_HOME,
  localConfig.dshHome,
  join(homedir(), '.dex-dsh'),
  join(homedir(), '.dsh'),
].filter((value) => value !== undefined && value !== '')

const explicit = readArg('--home')
const hasProfile = (home) => existsSync(join(home, 'profiles', profile, 'package.json'))
const home = explicit ?? candidates[0] ?? candidates.find(hasProfile) ?? join(homedir(), '.dex-dsh')
const profileDir = join(home, 'profiles', profile)

const manifest = {
  name: seed.manifestName,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: seed.bundles } },
}

const files = [
  ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
  ['cordis.yml', seed.cordis],
  ['cordis.patch.yml', seed.cordisPatch],
  ['pnpm-workspace.yaml', seed.pnpmWorkspace],
]

for (const [name, content] of files) {
  const target = join(profileDir, name)
  if (existsSync(target)) {
    console.log(`[setup-dsh-profile] 已存在，跳过：${target}`)
    continue
  }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(target, content, 'utf8')
  console.log(`[setup-dsh-profile] 已写入：${target}`)
}

console.log(
  `[setup-dsh-profile] profile 就绪：${profileDir}（bundles: ${seed.bundles.join(', ')}）`,
)

const bin = readArg('--bin') ?? process.env.DEX_DSH_BIN ?? localConfig.dshBin
if (bin === undefined) {
  console.log('[setup-dsh-profile] 未给出 --bin，跳过本地配置写入。若应用报「未找到 dsh CLI」：')
  console.log(
    '  node scripts/setup-dsh-profile.mjs --bin "<dsh 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js"',
  )
} else if (!existsSync(bin)) {
  console.error(`[setup-dsh-profile] --bin 指向的文件不存在：${bin}`)
  process.exitCode = 1
} else {
  // 版本一致性检查：CLI 必须与 profile 插件同版本，否则新插件 import 老 CLI 不存在的
  // 导出会让整棵插件树 fail-loud（症状像「插件坏了」，实为选错 CLI）。这里在**写入前**就拦下来。
  const expected = readPackageVersion(
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
  )
  const actual = readPackageVersion(join(dirname(dirname(bin)), 'package.json'))
  if (expected !== null && actual !== null && expected !== actual) {
    console.error(
      `[setup-dsh-profile] CLI 版本与 profile 插件不一致：CLI=${actual}，profile 期望=${expected}`,
    )
    console.error(
      `  这会让插件树整体加载失败（报错形如 "does not provide an export named ..."）。` +
        `请把 CLI 升到 ${expected}：`,
    )
    console.error(`    cd <dsh 安装目录> && pnpm add @deepseek-ai/dsh@${expected}`)
    console.error('[setup-dsh-profile] 为避免启动期 fail-loud，**未写入**本地配置。')
    process.exitCode = 1
  } else {
    if (expected !== null && actual !== null) {
      console.log(`[setup-dsh-profile] 版本一致：${actual}`)
    }
    writeFileSync(
      localConfigPath,
      `${JSON.stringify({ ...localConfig, dshHome: home, dshBin: bin }, null, 2)}\n`,
      'utf8',
    )
    console.log(`[setup-dsh-profile] 已写入本地配置：${localConfigPath}`)
    console.log(`  dshHome = ${home}`)
    console.log(`  dshBin  = ${bin}`)
  }
}
