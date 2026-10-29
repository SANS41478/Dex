import type { GraphNode } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import { countPluginUsage, describePluginNode } from './plugin-capability'
import type { TurnRecord } from './trace'

function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return { label: partial.id, type: 'tool', status: 'active', ...partial }
}

describe('describePluginNode', () => {
  it('已知包给出能力短语与连接度', () => {
    const brief = describePluginNode(
      node({ id: 'include:tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs' }),
      { incoming: 2, outgoing: 5 },
    )
    expect(brief.kindLabel).toBe('工具')
    expect(brief.capability).toBe('文件读写：read / write / edit / read_image')
    expect(brief.summary).toBe('文件读写：read / write / edit / read_image · 依赖 2 · 被依赖 5')
  })

  it('精确表未命中时按包名片段兜底', () => {
    const brief = describePluginNode(
      node({ id: 'x', moduleName: '@deepseek-ai/dsh-tool-fs-search-extra' }),
      { incoming: 0, outgoing: 0 },
    )
    // 片段表顺序：fs-search 先于 fs
    expect(brief.capability).toBe('文件搜索')
    expect(brief.summary).toBe('文件搜索')
  })

  it('无法识别能力时不编用途，只给类型角色', () => {
    const brief = describePluginNode(node({ id: 'x', moduleName: 'some-local-plugin' }), {
      incoming: 1,
      outgoing: 0,
    })
    expect(brief.capability).toBeNull()
    expect(brief.role).toContain('工具插件')
    expect(brief.summary).toBe('工具插件：向模型暴露可调用的工具 · 依赖 1')
  })

  it('内建行没有 moduleName 时同样回退到类型角色', () => {
    const brief = describePluginNode(node({ id: 'core', type: 'sandbox' }), {
      incoming: 0,
      outgoing: 3,
    })
    expect(brief.capability).toBeNull()
    expect(brief.summary).toBe('沙箱插件：约束工具的文件与命令权限 · 被依赖 3')
  })

  it('没有连接边时不显示连接度', () => {
    const brief = describePluginNode(node({ id: 'x', moduleName: '@deepseek-ai/dsh-tool-web' }), {
      incoming: 0,
      outgoing: 0,
    })
    expect(brief.summary).toBe('联网检索：web_search / web_fetch')
  })
})

describe('countPluginUsage', () => {
  it('统计本会话该插件被调用的次数', () => {
    const turns: TurnRecord[] = [
      {
        id: 'sess:t1',
        userMessage: '看看',
        status: 'completed',
        startedAt: 0,
        steps: [
          {
            id: 's1',
            turnId: 'sess:t1',
            index: 0,
            llmReasoning: '',
            status: 'success',
            startedAt: 0,
            toolCalls: [
              {
                id: 'c1',
                stepId: 's1',
                toolName: 'read',
                pluginId: 'plugin-fs',
                input: {},
                status: 'success',
                startedAt: 0,
              },
              {
                id: 'c2',
                stepId: 's1',
                toolName: 'grep',
                pluginId: 'plugin-search',
                input: {},
                status: 'success',
                startedAt: 0,
              },
            ],
          },
        ],
      },
    ]
    expect(countPluginUsage(turns, 'plugin-fs')).toBe(1)
    expect(countPluginUsage(turns, 'plugin-search')).toBe(1)
    expect(countPluginUsage(turns, 'plugin-missing')).toBe(0)
  })
})
