import { describe, expect, it } from 'vitest'
import { describeRunAsNode } from './startup-guard'

describe('describeRunAsNode', () => {
  it('环境干净时返回 null', () => {
    expect(describeRunAsNode({})).toBeNull()
    expect(describeRunAsNode({ ELECTRON_RUN_AS_NODE_OTHER: '1' })).toBeNull()
  })

  it('变量存在即判定退化（Electron 只看存在性，不看取值）', () => {
    for (const value of ['1', '0', 'true', 'false', '']) {
      expect(describeRunAsNode({ ELECTRON_RUN_AS_NODE: value })).not.toBeNull()
    }
  })

  it('报错文案点明症状、来源与处置方式', () => {
    const message = describeRunAsNode({ ELECTRON_RUN_AS_NODE: '1' })
    expect(message).toContain('ELECTRON_RUN_AS_NODE')
    expect(message).toContain('electron.app')
    expect(message).toContain('父进程')
    expect(message).toContain('electron.launch')
  })
})
