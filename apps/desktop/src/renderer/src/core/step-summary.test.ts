import { describe, expect, it } from 'vitest'
import {
  describeStepAction,
  describeToolCall,
  summarizeMessage,
  summarizeThinking,
  thinkingSize,
  toolActionLabel,
  toolTarget,
  turnOrdinal,
} from './step-summary'
import type { ToolCallRecord } from './trace'

function tool(partial: Partial<ToolCallRecord> & { id: string }): ToolCallRecord {
  return {
    stepId: 's1',
    toolName: 'read',
    pluginId: 'plugin-fs',
    input: {},
    status: 'success',
    startedAt: 0,
    ...partial,
  }
}

describe('toolActionLabel / toolTarget', () => {
  it('已知工具给人话动作，未知工具回退为下划线转空格', () => {
    expect(toolActionLabel('read')).toBe('读取文件')
    expect(toolActionLabel('pwsh')).toBe('执行命令')
    expect(toolActionLabel('brand_new_tool')).toBe('brand new tool')
    expect(toolActionLabel('')).toBe('调用工具')
  })

  it('按优先级取宾语，忽略空白与不可读类型', () => {
    expect(toolTarget({ path: 'README.md' })).toBe('README.md')
    expect(toolTarget({ file_path: 'a.ts', path: 'b.ts' })).toBe('b.ts')
    expect(toolTarget({ pattern: 'TODO' })).toBe('TODO')
    expect(toolTarget({ pattern: '   ' })).toBe('')
    expect(toolTarget({ nested: { a: 1 } })).toBe('')
    expect(toolTarget({ command: 'pnpm check' })).toBe('pnpm check')
  })
})

describe('describeStepAction', () => {
  it('单个工具 → 动作 + 宾语', () => {
    const action = describeStepAction({
      status: 'success',
      toolCalls: [tool({ id: 'c1', toolName: 'read', input: { path: 'README.md' } })],
    })
    expect(action.text).toBe('读取文件 README.md')
    expect(action.primary).toBe('读取文件')
    expect(action.count).toBe(1)
  })

  it('多个工具 → 首个动作 + 项数 + 首个宾语', () => {
    const action = describeStepAction({
      status: 'success',
      toolCalls: [
        tool({ id: 'c1', toolName: 'read', input: { path: 'README.md' } }),
        tool({ id: 'c2', toolName: 'grep', input: { pattern: 'TODO' } }),
        tool({ id: 'c3', toolName: 'edit', input: { path: 'a.ts' } }),
      ],
    })
    expect(action.text).toBe('读取文件 等 3 项操作 · README.md')
    expect(action.count).toBe(3)
  })

  it('无工具调用 → 生成回复（运行中为进行时）', () => {
    expect(describeStepAction({ status: 'success', toolCalls: [] }).text).toBe('生成回复')
    expect(describeStepAction({ status: 'running', toolCalls: [] }).text).toBe('正在生成回复')
  })

  it('超长宾语被截断，且不越界', () => {
    const long = 'x'.repeat(200)
    const action = describeStepAction(
      { status: 'success', toolCalls: [tool({ id: 'c1', input: { path: long } })] },
      30,
    )
    expect(action.text.length).toBeLessThanOrEqual(30)
    expect(action.text.endsWith('…')).toBe(true)
  })
})

describe('describeToolCall', () => {
  it('工具行给人话动作 + 宾语', () => {
    expect(describeToolCall(tool({ id: 'c1', toolName: 'grep', input: { pattern: 'TODO' } }))).toBe(
      '搜索内容 TODO',
    )
  })
})

describe('summarizeThinking', () => {
  it('取首段有内容的文字并压平空白', () => {
    expect(summarizeThinking('第一行结论\n\n第二段展开')).toBe('第一行结论')
    expect(summarizeThinking('- 先看 README\n- 再跑测试')).toBe('先看 README')
    expect(summarizeThinking('1. 读文件\n2. 改代码')).toBe('读文件')
    expect(summarizeThinking('   ')).toBe('')
  })

  it('超长时在句读处收口', () => {
    const text = `${'甲'.repeat(40)}。${'乙'.repeat(200)}`
    const summary = summarizeThinking(text, 60)
    expect(summary.endsWith('。')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(60)
  })

  it('没有句读时硬截断加省略号', () => {
    const summary = summarizeThinking('丙'.repeat(300), 50)
    expect(summary.length).toBe(50)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('thinkingSize / turnOrdinal / summarizeMessage', () => {
  it('统计思考规模', () => {
    expect(thinkingSize('')).toEqual({ chars: 0, lines: 0 })
    expect(thinkingSize('ab\ncd')).toEqual({ chars: 5, lines: 2 })
  })

  it('轮次序号从 turn id 解析，解析不了退回位置', () => {
    expect(turnOrdinal('sess-1:t3', 0)).toBe(3)
    expect(turnOrdinal('sess-1:t12', 4)).toBe(12)
    expect(turnOrdinal('t1', 4)).toBe(5)
    expect(turnOrdinal('', 0)).toBe(1)
  })

  it('提问摘要单行限长，空文本给出占位', () => {
    expect(summarizeMessage('  看 看\n项目  ')).toBe('看 看 项目')
    expect(summarizeMessage('')).toBe('（等待提问）')
    expect(summarizeMessage('字'.repeat(200), 20).length).toBe(20)
  })
})
