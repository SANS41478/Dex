import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEX_GRAPH_PORT, prepareDexPatches } from './dsh-patch'

const repoRoot = join('E:', 'repo')
const graphBundlePath = join(repoRoot, 'packages', 'bridges', 'dist', 'dex-graph-bridge.mjs')
const traceBundlePath = join(repoRoot, 'packages', 'bridges', 'dist', 'dex-trace-bridge.mjs')
const controlBundlePath = join(repoRoot, 'packages', 'bridges', 'dist', 'dex-model-control.mjs')

function makeFs(
  files: Record<string, string>,
  bundles: { graph: boolean; trace: boolean; control?: boolean },
) {
  const written: Record<string, string> = {}
  return {
    written,
    exists: (path: string) =>
      (path === graphBundlePath && bundles.graph) ||
      (path === traceBundlePath && bundles.trace) ||
      (path === controlBundlePath && bundles.control === true),
    readFile: (path: string) => {
      const content = files[path]
      if (content === undefined) throw new Error(`missing fixture: ${path}`)
      return content
    },
    writeFile: (path: string, data: string) => {
      written[path] = data
    },
  }
}

describe('prepareDexPatches', () => {
  const webserverTemplate = join(repoRoot, 'scripts', 'dsh', 'dex-webserver.patch.yml')
  const codingTemplate = join(repoRoot, 'scripts', 'dsh', 'dex-coding.patch.yml')
  const managementTemplate = join(repoRoot, 'scripts', 'dsh', 'dex-management.patch.yml')
  const bridgeTemplate = join(repoRoot, 'scripts', 'dsh', 'dex-bridge.patch.yml')
  const traceTemplate = join(repoRoot, 'scripts', 'dsh', 'dex-trace.patch.yml')
  const controlTemplate = join(repoRoot, 'scripts', 'dsh', 'dex-model-control.patch.yml')
  const fixtures = {
    [webserverTemplate]: 'port: DEX_GRAPH_PORT_PLACEHOLDER\n',
    [codingTemplate]: 'mode: workspace-write\n',
    [managementTemplate]: "name: '@deepseek-ai/dsh-workspace'\n",
    [bridgeTemplate]: "name: 'DEX_BRIDGE_URL_PLACEHOLDER'\n",
    [traceTemplate]: "name: 'DEX_TRACE_BUNDLE_URL_PLACEHOLDER'\n",
    [controlTemplate]: "name: 'DEX_MODEL_CONTROL_BUNDLE_URL_PLACEHOLDER'\n",
  }

  it('两个 bundle 都缺失时返回空，不生成任何 patch（避免整树 fail-loud）', () => {
    const fs = makeFs(fixtures, { graph: false, trace: false })
    const result = prepareDexPatches({ repoRoot, ...fs })
    expect(result).toEqual({ patchFiles: [], graphUrl: null, traceUrl: null, controlUrl: null })
    expect(fs.written).toEqual({})
  })

  it('仅图谱 bundle 存在时行为与 M1 一致（traceUrl 为空）', () => {
    const fs = makeFs(fixtures, { graph: true, trace: false })
    const result = prepareDexPatches({
      repoRoot,
      tempDir: join('C:', 'tmp'),
      ...fs,
    })

    expect(result.patchFiles).toHaveLength(4)
    expect(result.graphUrl).toBe(`ws://127.0.0.1:${DEX_GRAPH_PORT}/dex-graph`)
    expect(result.traceUrl).toBeNull()

    const [webserverPath, codingPath, managementPath, bridgePath] = result.patchFiles
    expect(fs.written[webserverPath ?? '']).toContain(`port: ${DEX_GRAPH_PORT}`)
    expect(fs.written[codingPath ?? '']).toContain('mode: workspace-write')
    expect(fs.written[managementPath ?? '']).toContain('@deepseek-ai/dsh-workspace')
    const rendered = fs.written[bridgePath ?? ''] ?? ''
    expect(rendered).toContain('file:///')
    expect(rendered).toContain('dex-graph-bridge.mjs')
    expect(rendered).not.toContain('DEX_BRIDGE_URL_PLACEHOLDER')
  })

  it('两个 bundle 都在场时渲染三段 patch 并返回双 URL', () => {
    const fs = makeFs(fixtures, { graph: true, trace: true })
    const result = prepareDexPatches({
      repoRoot,
      tempDir: join('C:', 'tmp'),
      ...fs,
    })

    expect(result.patchFiles).toHaveLength(5)
    expect(result.graphUrl).toBe(`ws://127.0.0.1:${DEX_GRAPH_PORT}/dex-graph`)
    expect(result.traceUrl).toBe(`ws://127.0.0.1:${DEX_GRAPH_PORT}/dex-trace`)

    const tracePath = result.patchFiles[4] ?? ''
    const rendered = fs.written[tracePath] ?? ''
    expect(rendered).toContain('file:///')
    expect(rendered).toContain('dex-trace-bridge.mjs')
    expect(rendered).not.toContain('DEX_TRACE_BUNDLE_URL_PLACEHOLDER')
  })

  it('模型控制 bundle 在场时增加控制 patch 与 URL', () => {
    const fs = makeFs(fixtures, { graph: true, trace: true, control: true })
    const result = prepareDexPatches({
      repoRoot,
      tempDir: join('C:', 'tmp'),
      ...fs,
    })

    expect(result.controlUrl).toBe('ws://127.0.0.1:4320/dex-control')
    expect(result.patchFiles).toHaveLength(6)
    const controlPath = result.patchFiles.at(-1) ?? ''
    expect(fs.written[controlPath] ?? '').toContain('dex-model-control.mjs')
  })
})
