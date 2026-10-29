import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canEnsureDshProfile,
  DEFAULT_DSH_HOME_DIRNAME,
  DEX_DSH_PROFILE,
  DSH_CREDENTIALS_FILENAME,
  DSH_PROFILE_SEED_RELPATH,
  ensureDshProfile,
  fallbackDshHome,
  hasAnyCredential,
  hasDshProfile,
  listDshHomeCandidates,
  loadDshLocalConfig,
  loadDshProfileSeed,
  parseDshProfileSeed,
  readProfileDshVersion,
  resolveDshBin,
  resolveDshHome,
  resolveWritableDshHome,
} from './dsh-profile'

/**
 * 唯一的内存 fs 替身。`landing` 控制写入是否真的落盘：
 *
 * - `landing: true`（默认）—— 模拟真实磁盘：mkdir 建目录、writeFile 落文件、remove 删除。
 * - `landing: false` —— 模拟"写入被静默拦截"，用于验证探测逻辑能识别出不可写。
 */
const createFs = (existing: readonly string[], options: { landing?: boolean } = {}) => {
  const landing = options.landing ?? true
  const set = new Set(existing.map((path) => resolve(path).toLowerCase()))
  const written: string[] = []
  const mkdirCalls: string[] = []
  /** 递归建目录：真实 `mkdir -p` 会把整条祖先链都建出来，替身必须同样处理。 */
  const mkdirRecursive = (path: string): void => {
    const target = resolve(path).toLowerCase()
    set.add(target)
    for (let parent = dirname(target); parent !== target; parent = dirname(parent)) {
      if (set.has(parent)) break
      set.add(parent)
    }
  }
  return {
    written,
    mkdirCalls,
    /** 替身自省用：某个路径当前是否"在磁盘上"。 */
    present: (path: string): boolean => set.has(resolve(path).toLowerCase()),
    exists: (path: string): boolean => set.has(resolve(path).toLowerCase()),
    mkdir: (path: string): void => {
      mkdirCalls.push(path)
      mkdirRecursive(path)
    },
    writeFile: (path: string): void => {
      written.push(path)
      if (landing) set.add(resolve(path).toLowerCase())
    },
    remove: (path: string): void => {
      set.delete(resolve(path).toLowerCase())
    },
  }
}

/** 与 createFs 同源，但文件不落盘——只用于「写不进去」这一类判定。 */
const createNonLandingFs = (existing: readonly string[] = []) =>
  createFs(existing, { landing: false })

describe('listDshHomeCandidates', () => {
  it('显式指定在前，约定目录在后；重复项去掉', () => {
    const candidates = listDshHomeCandidates({
      env: { DSH_HOME: 'C:/a/.dsh', DEX_DSH_HOME: 'C:/b/.dex-dsh' },
      home: 'C:/Users/x',
      localHome: 'C:/b/.dex-dsh',
    })
    expect(candidates.slice(0, 2)).toEqual(['C:/a/.dsh', 'C:/b/.dex-dsh'])
    // 重复的 localHome 被去掉；末尾补上两个约定目录
    expect(candidates).toHaveLength(4)
    expect(candidates.slice(2)).toEqual([
      join('C:/Users/x', '.dex-dsh'),
      join('C:/Users/x', '.dsh'),
    ])
  })
})

describe('resolveDshHome', () => {
  it('没有显式指定时，选已有 dex profile 的约定目录', () => {
    const fs = createFs([join('C:/Users/x', DEFAULT_DSH_HOME_DIRNAME, 'profiles', 'dex')])
    expect(resolveDshHome({ env: {}, home: 'C:/Users/x', exists: fs.exists })).toBe(
      join('C:/Users/x', DEFAULT_DSH_HOME_DIRNAME),
    )
  })

  it('约定目录都没有 profile 时落到 ~/.dex-dsh（不污染用户其它 dsh 工具的 ~/.dsh）', () => {
    expect(resolveDshHome({ env: {}, home: 'C:/Users/x', exists: () => false })).toBe(
      join('C:/Users/x', DEFAULT_DSH_HOME_DIRNAME),
    )
  })

  it('显式 DSH_HOME / DEX_DSH_HOME 无条件优先（哪怕还没有 profile）', () => {
    expect(resolveDshHome({ env: { DEX_DSH_HOME: 'C:/b/.dex-dsh' }, exists: () => false })).toBe(
      'C:/b/.dex-dsh',
    )
    expect(
      resolveDshHome({
        env: { DSH_HOME: 'C:/a/.dsh', DEX_DSH_HOME: 'C:/b/.dex-dsh' },
        exists: () => false,
      }),
    ).toBe('C:/a/.dsh')
  })
})

describe('resolveDshBin', () => {
  it('DEX_DSH_BIN 覆盖优先，且必须真实存在', () => {
    const hit = resolveDshBin({ env: { DEX_DSH_BIN: 'E:/c/dsh.js' }, exists: () => true })
    expect(hit.bin).toBe('E:/c/dsh.js')
    expect(hit.degraded).toBe(false)
    expect(hit.missingExplicit).toBeNull()

    const miss = resolveDshBin({ env: { DEX_DSH_BIN: 'E:/c/dsh.js' }, exists: () => false })
    expect(miss.bin).toBeNull()
    // 失效的显式路径要留痕，供 index/host 说人话（BUGFIX-HOST-01）
    expect(miss.missingExplicit).toBe('E:/c/dsh.js')
  })

  it('显式档存在时不做二次挑选：候选链里另有 CLI 也仍用它（尊重用户点名）', () => {
    const resolved = resolveDshBin({
      env: { DEX_DSH_BIN: 'E:/c/dsh.js' },
      home: 'C:/Users/x/.dex-dsh',
      expectedVersion: '0.2.1-alpha.1',
      // 盘上什么都有：显式档必须原样胜出，不参与版本校验、也不被候选链抢位。
      exists: () => true,
    })
    expect(resolved.bin).toBe('E:/c/dsh.js')
    expect(resolved.missingExplicit).toBeNull()
    expect(resolved.degraded).toBe(false)
  })

  it('显式档已失效时跳过而非判死：候选链里的 profile CLI 仍能被选中（BUGFIX-HOST-01）', () => {
    // 现场：DEX_DSH_BIN 指向已删除的 F:\Deepseek-harness-desktop\dsh-install\…，
    // 而 ~/.dex-dsh/profiles/dex/node_modules 里装着 CLI，宿主却恒报 missing。
    const home = 'C:/Users/x/.dex-dsh'
    const profileBin = join(
      home,
      'profiles',
      DEX_DSH_PROFILE,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    const stale = 'F:/Deepseek-harness-desktop/dsh-install/node_modules/@deepseek-ai/dsh/lib/bin.js'
    const resolved = resolveDshBin({
      env: { DEX_DSH_BIN: stale },
      home,
      exists: (path) => path === profileBin,
    })
    expect(resolved.bin).toBe(profileBin)
    expect(resolved.degraded).toBe(false)
    expect(resolved.missingExplicit).toBe(stale)
  })

  it('本地配置的 dshBin 次之（本机 CLI 装在仓库外的独立工程）', () => {
    const bin = resolveDshBin({
      env: {},
      localBin: 'F:/tools/dsh-install/node_modules/@deepseek-ai/dsh/lib/bin.js',
      home: 'C:/Users/x',
      exists: () => true,
    })
    expect(bin.bin).toBe('F:/tools/dsh-install/node_modules/@deepseek-ai/dsh/lib/bin.js')
  })

  it('显式档不参与版本校验：用户点名了就用它，哪怕版本不符', () => {
    const hit = resolveDshBin({
      env: { DEX_DSH_BIN: 'E:/c/old-dsh.js' },
      exists: () => true,
      expectedVersion: '0.1.7-rc.2',
      readFile: () => JSON.stringify({ version: '0.1.6-alpha.2' }),
    })
    expect(hit.bin).toBe('E:/c/old-dsh.js')
    expect(hit.degraded).toBe(false)
    expect(hit.versionSkipped).toEqual([])
  })

  it('按候选 home 依次找 profiles/<profile>/node_modules、profiles/node_modules、node_modules 三个落位', () => {
    // home 是**具体 dsh home**（非用户主目录）；用 DSH_HOME 显式固定，避免依赖真实 homedir。
    const home = 'C:/x/.dsh'
    const profileHit = join(
      home,
      'profiles',
      DEX_DSH_PROFILE,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    const profilesHit = join(
      home,
      'profiles',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    const hoistedHit = join(home, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    expect(
      resolveDshBin({ env: { DSH_HOME: home }, exists: (path) => path === profileHit }).bin,
    ).toBe(profileHit)
    expect(
      resolveDshBin({ env: { DSH_HOME: home }, exists: (path) => path === profilesHit }).bin,
    ).toBe(profilesHit)
    expect(
      resolveDshBin({ env: { DSH_HOME: home }, exists: (path) => path === hoistedHit }).bin,
    ).toBe(hoistedHit)
  })

  it('回归（BUGFIX-M4-08）：profile 内 CLI 优先于共享池，不抢另一次安装的 CLI', () => {
    // 现场（2026-09-29）：`~/.dsh/profiles/node_modules` 是 2026-09-16 遗留的**符号链接农场**，
    // 指向源码仓库 apps/cli；它的版本也是 0.1.7-rc.2，所以版本校验**放它过去**。
    // 但它的 bundle patch 来自源码 HEAD（含 `id: otel → @deepseek-ai/dsh-otel`，npm 上根本没有
    // 0.1.7-rc.2），而 entry 模块从 profile 的 npm 安装解析 → ERR_MODULE_NOT_FOUND → exit 1。
    // 判据：profile 自己装的 CLI 才与 profile 的插件同源。
    const home = 'C:/x/.dsh'
    const profileBin = join(
      home,
      'profiles',
      DEX_DSH_PROFILE,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    const poolBin = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const both = (path: string): boolean => path === profileBin || path === poolBin

    // 两者并存 → profile 内胜出（修复前这里会返回 poolBin）
    expect(resolveDshBin({ env: { DSH_HOME: home }, home, exists: both }).bin).toBe(profileBin)
  })

  it('回归（BUGFIX-M4-08）：profile 内没有 CLI 时仍回落到共享池（不破坏旧安装）', () => {
    const home = 'C:/x/.dsh'
    const poolBin = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    expect(
      resolveDshBin({ env: { DSH_HOME: home }, home, exists: (path) => path === poolBin }).bin,
    ).toBe(poolBin)
  })

  it('profile 参数决定「profile 内 CLI」这一首位候选；缺省为 dex', () => {
    const home = 'C:/x/.dsh'
    const webBin = join(
      home,
      'profiles',
      'web',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    const onlyWeb = (path: string): boolean => path === webBin
    expect(resolveDshBin({ env: { DSH_HOME: home }, profile: 'web', exists: onlyWeb }).bin).toBe(
      webBin,
    )
    // 缺省 profile=dex 时同一路径不该命中
    expect(resolveDshBin({ env: { DSH_HOME: home }, exists: onlyWeb }).bin).toBeNull()
  })

  it('回归（BUGFIX-M4-07）：无显式 env 时入参 home 直接作候选首位，不再被当主目录拼一层', () => {
    // 缺陷现场：bootstrapDshHome 裁决 home=C:/x/.dsh（具体 dsh home），CLI 就在其
    // profiles/node_modules 下；旧实现把它当用户主目录，roots 全落
    // `C:/x/.dsh/.dex-dsh/...` 这类不存在路径 → bin 恒 null → 宿主 missing。
    const home = 'C:/x/.dsh'
    const cli = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const result = resolveDshBin({ env: {}, home, exists: (path) => path === cli })
    expect(result.bin).toBe(cli)
  })

  it('回归（BUGFIX-M4-07）：具体 home 候选同样过版本校验，匹配时命中不降级', () => {
    const home = 'C:/x/.dsh'
    const cli = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pkg = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const result = resolveDshBin({
      env: {},
      home,
      expectedVersion: '0.1.7-rc.2',
      exists: (path) => path === cli || path === pkg,
      readFile: (path) =>
        path === pkg ? JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }) : '',
    })
    expect(result.bin).toBe(cli)
    expect(result.degraded).toBe(false)
    expect(result.versionSkipped).toEqual([])
  })

  it('仓库内也能找到（未来把 dsh 装进 monorepo 时无需改代码）', () => {
    const repoRoot = 'E:/dexAgent'
    const bin = resolveDshBin({
      env: {},
      repoRoot,
      exists: (path) => path.startsWith(join(repoRoot, 'node_modules')),
    })
    expect(bin.bin).toBe(join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })

  it('哪里都没有时返回 null（不抛异常）', () => {
    const result = resolveDshBin({ env: {}, exists: () => false })
    expect(result.bin).toBeNull()
    expect(result.degraded).toBe(false)
  })
})

describe('resolveDshBin · 版本校验', () => {
  /**
   * 构造一个「指定 home 下有 CLI」的场景。候选链首位是入参 `home`（具体 dsh home，缺省时
   * 才由 `resolveDshHome` 解析），所以这里用 `DSH_HOME` 显式指定 home，让 CLI 落在确定位置。
   */
  const cliUnder = (home: string): string =>
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  const versionedFs = (home: string, version: string | null) => {
    const cli = cliUnder(home)
    const pkg = join(dirname(dirname(cli)), 'package.json')
    return {
      cli,
      exists: (path: string): boolean => path === cli || (version !== null && path === pkg),
      readFile: (path: string): string => {
        if (path === pkg && version !== null) return JSON.stringify({ version })
        throw new Error(`unexpected read: ${path}`)
      },
    }
  }

  it('版本不符时不选中它：降级使用并如实记录（本机现场：CLI 0.1.6 vs profile 0.1.7-rc.2）', () => {
    const home = 'C:/x/.dsh'
    const fs = versionedFs(home, '0.1.6-alpha.2')
    const result = resolveDshBin({
      env: { DSH_HOME: home },
      expectedVersion: '0.1.7-rc.2',
      ...fs,
    })
    expect(result.bin).toBe(fs.cli)
    expect(result.degraded).toBe(true)
    expect(result.versionSkipped).toEqual([{ bin: fs.cli, version: '0.1.6-alpha.2' }])
  })

  it('版本一致时直接选中，不降级', () => {
    const home = 'C:/x/.dsh'
    const fs = versionedFs(home, '0.1.7-rc.2')
    const result = resolveDshBin({
      env: { DSH_HOME: home },
      expectedVersion: '0.1.7-rc.2',
      ...fs,
    })
    expect(result.bin).toBe(fs.cli)
    expect(result.degraded).toBe(false)
    expect(result.versionSkipped).toEqual([])
  })

  it('未提供 expectedVersion 时退化为「只判存在」旧行为', () => {
    const home = 'C:/x/.dsh'
    const fs = versionedFs(home, null)
    const result = resolveDshBin({ env: { DSH_HOME: home }, ...fs })
    expect(result.bin).toBe(fs.cli)
    expect(result.degraded).toBe(false)
    expect(result.expectedVersion).toBeNull()
  })

  it('CLI 的 package.json 读不出时不误判为「存在即匹配」', () => {
    const home = 'C:/x/.dsh'
    const fs = versionedFs(home, null)
    const result = resolveDshBin({
      env: { DSH_HOME: home },
      expectedVersion: '0.1.7-rc.2',
      ...fs,
    })
    // 读不出 → version 为 null；仍算「版本不符」并降级，但证据里如实记录 null
    expect(result.bin).toBe(fs.cli)
    expect(result.degraded).toBe(true)
    expect(result.versionSkipped).toEqual([{ bin: fs.cli, version: null }])
  })
})

describe('readProfileDshVersion', () => {
  it('从 profiles/<profile>/node_modules/@deepseek-ai/dsh-base/package.json 读版本', () => {
    const target = join(
      'C:/x',
      'profiles',
      'dex',
      'node_modules',
      '@deepseek-ai',
      'dsh-base',
      'package.json',
    )
    const version = readProfileDshVersion({
      home: 'C:/x',
      exists: (path) => path === target,
      readFile: () => JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.7-rc.2' }),
    })
    expect(version).toBe('0.1.7-rc.2')
  })

  it('文件缺失或内容非法时返回 null（不抛异常）', () => {
    expect(readProfileDshVersion({ home: 'C:/x', exists: () => false })).toBeNull()
    expect(
      readProfileDshVersion({ home: 'C:/x', exists: () => true, readFile: () => 'not json' }),
    ).toBeNull()
    expect(
      readProfileDshVersion({
        home: 'C:/x',
        exists: () => true,
        readFile: () => JSON.stringify({ version: 42 }),
      }),
    ).toBeNull()
  })
})

describe('hasDshProfile', () => {
  it('判据是 profiles/<profile>/package.json', () => {
    const seen: string[] = []
    const ok = hasDshProfile({
      home: 'C:/x/.dex-dsh',
      exists: (path) => {
        seen.push(path)
        return true
      },
    })
    expect(ok).toBe(true)
    expect(seen[0]).toBe(join('C:/x/.dex-dsh', 'profiles', 'dex', 'package.json'))
  })
})

describe('ensureDshProfile', () => {
  const seed = parseDshProfileSeed(
    JSON.stringify({
      profile: 'dex',
      bundles: ['@deepseek-ai/dsh-base'],
      manifestName: 'dsh-profile-dex',
      cordis: '[]\n',
      cordisPatch: '[]\n',
      pnpmWorkspace: 'packages:\n  - .\n',
    }),
  )

  it('profile 缺失时补齐四个文件', () => {
    const fs = createFs([])
    const result = ensureDshProfile({
      home: 'C:/x/.dex-dsh',
      seed,
      exists: fs.exists,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    })
    expect(result.created).toEqual([
      'package.json',
      'cordis.yml',
      'cordis.patch.yml',
      'pnpm-workspace.yaml',
    ])
    expect(result.error).toBeNull()
    expect(fs.written).toHaveLength(4)
    // 目录只建一次（原先放在循环里会调四次）
    expect(fs.mkdirCalls).toHaveLength(1)
  })

  it('已存在的文件一律不覆盖（保护用户手写的 cordis.patch.yml）', () => {
    const profileDir = join('C:/x/.dex-dsh', 'profiles', 'dex')
    const fs = createFs([join(profileDir, 'cordis.patch.yml'), join(profileDir, 'package.json')])
    const result = ensureDshProfile({
      home: 'C:/x/.dex-dsh',
      seed,
      exists: fs.exists,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    })
    expect(result.created).toEqual(['cordis.yml', 'pnpm-workspace.yaml'])
    expect(fs.written).not.toContain(join(profileDir, 'cordis.patch.yml'))
  })

  it('播种后 hasDshProfile 判为就绪', () => {
    const fs = createFs([])
    ensureDshProfile({
      home: 'C:/x/.dex-dsh',
      seed,
      exists: fs.exists,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    })
    expect(hasDshProfile({ home: 'C:/x/.dex-dsh', exists: fs.exists })).toBe(true)
  })

  it('profile 内文件缺失时 hasDshProfile 仍判为未就绪', () => {
    // 光有目录、没有 package.json 不算就绪——这是 dsh 的真实判据
    const fs = createFs([])
    fs.mkdir(join('C:/x/.dex-dsh', 'profiles', 'dex'))
    expect(hasDshProfile({ home: 'C:/x/.dex-dsh', exists: fs.exists })).toBe(false)
  })

  // 以下三条防的是 BUGFIX-M4-05：EPERM 曾以未捕获异常形式炸掉整个 whenReady 回调。
  it('profile 已就绪时完全不碰磁盘（不 mkdir、不写文件）', () => {
    const profileDir = join('C:/x/.dex-dsh', 'profiles', 'dex')
    const fs = createFs([
      join(profileDir, 'package.json'),
      join(profileDir, 'cordis.yml'),
      join(profileDir, 'cordis.patch.yml'),
      join(profileDir, 'pnpm-workspace.yaml'),
    ])
    const result = ensureDshProfile({
      home: 'C:/x/.dex-dsh',
      seed,
      exists: fs.exists,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
    })
    expect(result).toEqual({ profileDir, created: [], error: null })
    expect(fs.mkdirCalls).toHaveLength(0)
    expect(fs.written).toHaveLength(0)
  })

  it('对已存在祖先无写权限（本机 C:\\Users 现场）：返回 EPERM 结构化错误，MUST NOT 抛异常', () => {
    // 真实现场：C:\Users 存在，但当前用户无权在其中建子目录（Windows 默认 ACL）→ EPERM
    const fs = createFs([join('C:/Users')])
    const eperm = Object.assign(
      new Error("EPERM: operation not permitted, mkdir 'C:\\Users\\user\\.dex-dsh\\profiles\\dex'"),
      {
        code: 'EPERM',
      },
    )
    const result = ensureDshProfile({
      home: 'C:/Users/user/.dex-dsh',
      seed,
      exists: fs.exists,
      mkdir: () => {
        throw eperm
      },
      writeFile: fs.writeFile,
    })
    expect(result.error?.code).toBe('EPERM')
    // 必须点破「这是权限问题、祖先目录不可写」，而不是含糊的「路径不存在」
    expect(result.error?.message).toContain('无权在')
    expect(result.error?.message).toContain('权限问题')
    // 真凶是最近的已存在祖先 C:\Users，而不是 home 本身
    expect(result.error?.message).toContain(join('C:/Users'))
    // 必须明确排除「路径不存在」这一误读方向
    expect(result.error?.message).toContain('不是路径不存在')
    expect(result.created).toEqual([])
    expect(fs.written).toHaveLength(0)
  })

  it('目录可建但文件写入失败：报告失败文件名，已写入的不回滚', () => {
    const fs = createFs([])
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const result = ensureDshProfile({
      home: 'C:/x/.dex-dsh',
      seed,
      exists: fs.exists,
      mkdir: fs.mkdir,
      writeFile: (path) => {
        if (path.endsWith('cordis.yml')) throw eacces
        fs.writeFile(path)
      },
    })
    expect(result.created).toEqual(['package.json'])
    expect(result.error?.code).toBe('EACCES')
    // 目录确实建出来了（mkdir 成功 → home 与父目录都在），属于权限不足而非祖先不可写
    expect(fs.present(join('C:/x/.dex-dsh', 'profiles', 'dex'))).toBe(true)
    expect(result.error?.message).toContain('权限不足')
    expect(result.error?.message).not.toContain('无权在')
  })
})

describe('canEnsureDshProfile', () => {
  it('无 profile 但目录可写 → true，且探针文件被清理', () => {
    const fs = createFs([])
    const ok = canEnsureDshProfile({ home: 'C:/x/.dex-dsh', ...fs })
    expect(ok).toBe(true)
    expect(fs.exists(join('C:/x/.dex-dsh', 'profiles', 'dex', '.dex-probe-write'))).toBe(false)
  })

  it('mkdir 报 EPERM（父目录不存在）→ false，不抛异常', () => {
    const ok = canEnsureDshProfile({
      home: 'C:/Users/user/.dex-dsh',
      exists: () => false,
      mkdir: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
      writeFile: () => undefined,
      remove: () => undefined,
    })
    expect(ok).toBe(false)
  })

  it('目录可建但探针写不进去（只读/被拦截）→ false', () => {
    // landing:false 模拟「writeFile 静默不落盘」——探针必须真的能验出这种情况
    const fs = createNonLandingFs()
    const ok = canEnsureDshProfile({ home: 'C:/x/.dex-dsh', ...fs })
    expect(ok).toBe(false)
  })

  it('已有 dex profile 的 home 直接算可用（不因探针失败误判）', () => {
    const profileDir = join('C:/x/.dsh', 'profiles', 'dex')
    const ok = canEnsureDshProfile({
      home: 'C:/x/.dsh',
      exists: (path) =>
        resolve(path).toLowerCase() === resolve(join(profileDir, 'package.json')).toLowerCase(),
      mkdir: () => {
        throw new Error('不该走到这里')
      },
      writeFile: () => {
        throw new Error('不该走到这里')
      },
      remove: () => undefined,
    })
    expect(ok).toBe(true)
  })
})

describe('resolveWritableDshHome', () => {
  const writeEverything = {
    mkdir: (): void => undefined,
    writeFile: (): void => undefined,
    remove: (): void => undefined,
  }

  it('显式档指向不可写路径时跳到下一个可写候选（本机现场：MR 不存在，~/.dsh 有 dex profile）', () => {
    // 已有的 dex profile 只存在于 ~/.dsh；C:/Users/user/.dex-dsh 整条路径都不存在。
    const readyProfile = join('C:/Users/x', '.dsh', 'profiles', 'dex', 'package.json')
    const resolved = resolveWritableDshHome({
      env: {},
      home: 'C:/Users/x',
      localHome: 'C:/Users/user/.dex-dsh',
      exists: (path) => resolve(path).toLowerCase() === resolve(readyProfile).toLowerCase(),
      // 除已有 profile 外，任何 mkdir 都失败（模拟 C:\Users\user 不存在）
      ...writeEverything,
      mkdir: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
    })
    expect(resolved.home).toBe(join('C:/Users/x', '.dsh'))
    expect(resolved.skipped).toContain('C:/Users/user/.dex-dsh')
  })

  it('首位候选可写且有凭据时：尾部候选根本不被探测（自愈探测必须廉价）', () => {
    const first = join('C:/Users/x', '.dex-dsh')
    const credFile = join(first, DSH_CREDENTIALS_FILENAME)
    const tailDir = join('C:/Users/x', '.dsh').toLowerCase()
    const touched: string[] = []
    const resolved = resolveWritableDshHome({
      env: {},
      home: 'C:/Users/x',
      localHome: first,
      exists: (path) => {
        const key = resolve(path).toLowerCase()
        touched.push(key)
        if (key === resolve(credFile).toLowerCase()) return true
        // 已有 dex profile 即算「可写」，避免走 mkdir 探针
        return key.endsWith(join('profiles', 'dex', 'package.json').toLowerCase())
      },
      readFile: () => 'version: 1\nrefs:\n  RINGS_API_KEY: rllm_lat_abc.def\n',
      ...writeEverything,
    })
    expect(resolved.home).toBe(first)
    expect(resolved.credentialReady).toBe(true)
    // 全程没有触达尾部候选 ~/.dsh
    expect(touched.some((p) => p.startsWith(tailDir))).toBe(false)
  })

  it('全部候选都不可写时回退到候选链首位（保持原行为，由上层如实报错）', () => {
    const resolved = resolveWritableDshHome({
      env: { DEX_DSH_HOME: 'C:/nope/.dex-dsh' },
      home: 'C:/Users/x',
      exists: () => false,
      ...writeEverything,
      mkdir: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
    })
    expect(resolved.home).toBe('C:/nope/.dex-dsh')
    expect(resolved.skipped).toHaveLength(3)
  })
})

describe('hasAnyCredential', () => {
  it('refs 段下有空值行不算，只认非空 API key', () => {
    const present = join('C:/x', '.dex-dsh', DSH_CREDENTIALS_FILENAME)
    const withRefs = hasAnyCredential({
      home: join('C:/x', '.dex-dsh'),
      exists: (path) => resolve(path).toLowerCase() === resolve(present).toLowerCase(),
      readFile: () => 'version: 1\nrefs:\n  RINGS_API_KEY: rllm_lat_abc.def\n',
    })
    expect(withRefs).toBe(true)

    const emptyRefs = hasAnyCredential({
      home: join('C:/x', '.dex-dsh'),
      exists: (path) => resolve(path).toLowerCase() === resolve(present).toLowerCase(),
      readFile: () => 'version: 1\nrefs:\n  RINGS_API_KEY: \n',
    })
    expect(emptyRefs).toBe(false)

    // records 段（授权记录）不是模型凭据
    const onlyRecords = hasAnyCredential({
      home: join('C:/x', '.dex-dsh'),
      exists: (path) => resolve(path).toLowerCase() === resolve(present).toLowerCase(),
      readFile: () =>
        'version: 1\nrefs:\nrecords:\n  client-connection/browser-session:\n    kind: grant\n',
    })
    expect(onlyRecords).toBe(false)
  })

  it('文件不存在时返回 false（不抛异常）', () => {
    expect(hasAnyCredential({ home: join('C:/x', '.dex-dsh'), exists: () => false })).toBe(false)
  })
})

describe('resolveWritableDshHome · 凭据—home 一致性', () => {
  const writeEverything = {
    mkdir: (): void => undefined,
    writeFile: (): void => undefined,
    remove: (): void => undefined,
  }

  it('首个可写候选无凭据时，让位给候选链后面带凭据的 home（本机现场：~/.dex-dsh 无、~/.dsh 有）', () => {
    const noCredHome = join('C:/Users/x', '.dex-dsh')
    const withCredHome = join('C:/Users/x', '.dsh')
    const credFile = join(withCredHome, DSH_CREDENTIALS_FILENAME)
    const resolved = resolveWritableDshHome({
      env: {},
      home: 'C:/Users/x',
      localHome: noCredHome,
      // 两个 home 都有 dex profile（可写判据成立），凭据只在 ~/.dsh。
      exists: (path) => {
        const key = resolve(path).toLowerCase()
        if (key === resolve(credFile).toLowerCase()) return true
        return key.endsWith(join('profiles', 'dex', 'package.json').toLowerCase())
      },
      readFile: () => 'version: 1\nrefs:\n  RINGS_API_KEY: rllm_lat_abc.def\n',
      ...writeEverything,
    })
    expect(resolved.home).toBe(withCredHome)
    expect(resolved.credentialReady).toBe(true)
    expect(resolved.credentialMissed).toContain(noCredHome)
  })

  it('首个可写候选已有凭据时立即返回，不继续探测尾部候选（保持旧实现的廉价性）', () => {
    const withCredHome = join('C:/Users/x', '.dex-dsh')
    const credFile = join(withCredHome, DSH_CREDENTIALS_FILENAME)
    const tailDir = join('C:/Users/x', '.dsh').toLowerCase()
    const touched: string[] = []
    const resolved = resolveWritableDshHome({
      env: {},
      home: 'C:/Users/x',
      localHome: withCredHome,
      exists: (path) => {
        const key = resolve(path).toLowerCase()
        touched.push(key)
        if (key === resolve(credFile).toLowerCase()) return true
        return key.endsWith(join('profiles', 'dex', 'package.json').toLowerCase())
      },
      readFile: () => 'version: 1\nrefs:\n  RINGS_API_KEY: rllm_lat_abc.def\n',
      ...writeEverything,
    })
    expect(resolved.home).toBe(withCredHome)
    expect(resolved.credentialReady).toBe(true)
    // 全程没有触达尾部候选 ~/.dsh
    expect(touched.some((p) => p.startsWith(tailDir))).toBe(false)
  })

  it('所有可写候选都没凭据时：仍用首个可写候选，但如实标记 credentialReady=false', () => {
    const noCredHome = join('C:/Users/x', '.dex-dsh')
    const resolved = resolveWritableDshHome({
      env: {},
      home: 'C:/Users/x',
      localHome: noCredHome,
      exists: (path) =>
        resolve(path)
          .toLowerCase()
          .endsWith(join('profiles', 'dex', 'package.json').toLowerCase()),
      ...writeEverything,
    })
    expect(resolved.home).toBe(noCredHome)
    expect(resolved.credentialReady).toBe(false)
    expect(resolved.credentialMissed).toEqual([])
  })
})

describe('fallbackDshHome', () => {
  it('落在系统临时目录下的 dex-dsh（保证可写）', () => {
    expect(fallbackDshHome('C:/tmp')).toBe(join('C:/tmp', 'dex-dsh'))
  })
})

describe('loadDshProfileSeed / loadDshLocalConfig', () => {
  // main → src → desktop → apps → 仓库根
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

  it('读得到仓库里的播种文件，且与 setup 脚本共用同一份事实源', () => {
    const seed = loadDshProfileSeed({ repoRoot })
    expect(seed).not.toBeNull()
    expect(seed?.profile).toBe('dex')
    expect(seed?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
    // 脚本读的也是这个文件，内容必须能解析
    const raw = readFileSync(join(repoRoot, DSH_PROFILE_SEED_RELPATH), 'utf8')
    expect(parseDshProfileSeed(raw).manifestName).toBe('dsh-profile-dex')
  })

  it('文件缺失时返回 null', () => {
    expect(loadDshProfileSeed({ repoRoot, exists: () => false })).toBeNull()
  })

  it('本地配置缺失/非法都当空配置，不让启动挂掉', () => {
    expect(loadDshLocalConfig({ repoRoot, exists: () => false })).toEqual({})
    expect(
      loadDshLocalConfig({
        repoRoot,
        exists: () => true,
        readFile: () => '{ not json',
      }),
    ).toEqual({})
    expect(
      loadDshLocalConfig({
        repoRoot,
        exists: () => true,
        readFile: () => JSON.stringify({ dshBin: 'F:/x/bin.js' }),
      }),
    ).toEqual({ dshBin: 'F:/x/bin.js' })
  })
})
