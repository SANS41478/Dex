import { describe, expect, it } from 'vitest'
import {
  createToolOwnerResolver,
  TOOL_OWNERS,
  type ToolOwnerEntryLike,
  UNKNOWN_PLUGIN_ID,
} from './tool-owners'

function resolverFor(entries: ToolOwnerEntryLike[]) {
  return createToolOwnerResolver(() => entries)
}

describe('createToolOwnerResolver（工具名 → pluginId）', () => {
  it('命中静态表且条目在场时返回 entry.id（M1 图谱节点锚点）', () => {
    const resolve = resolverFor([
      { id: 'entry-fs', moduleName: '@deepseek-ai/dsh-tool-fs' },
      { id: 'entry-todo', moduleName: '@deepseek-ai/dsh-tool-todo' },
    ])
    expect(resolve('read')).toBe('entry-fs')
    expect(resolve('write')).toBe('entry-fs')
    expect(resolve('todo_write')).toBe('entry-todo')
  })

  it('同名工具按候选顺序取第一个在场包（常驻实现优先，缺失时回退）', () => {
    const persistentOnly = resolverFor([
      { id: 'entry-bash-persistent', moduleName: '@deepseek-ai/dsh-tool-bash-persistent' },
    ])
    expect(persistentOnly('bash')).toBe('entry-bash-persistent')

    const both = resolverFor([
      { id: 'entry-bash-persistent', moduleName: '@deepseek-ai/dsh-tool-bash-persistent' },
      { id: 'entry-bash', moduleName: '@deepseek-ai/dsh-tool-bash' },
    ])
    expect(both('bash')).toBe('entry-bash')
  })

  it('未知工具、表内包不在场、缺 moduleName 均回退 unknown', () => {
    const resolve = resolverFor([
      { id: 'entry-x' },
      { id: 'entry-other', moduleName: '@deepseek-ai/dsh-unknown' },
    ])
    expect(resolve('no_such_tool')).toBe(UNKNOWN_PLUGIN_ID)
    expect(resolve('read')).toBe(UNKNOWN_PLUGIN_ID)
  })

  it('条目读取每次求值（插件增删后解析跟着变）', () => {
    let entries: ToolOwnerEntryLike[] = []
    const resolve = createToolOwnerResolver(() => entries)
    expect(resolve('grep')).toBe(UNKNOWN_PLUGIN_ID)
    entries = [{ id: 'entry-search', moduleName: '@deepseek-ai/dsh-tool-fs-search' }]
    expect(resolve('grep')).toBe('entry-search')
  })

  it('表内每个工具名都有非空候选（防手误空数组）', () => {
    for (const [tool, modules] of Object.entries(TOOL_OWNERS)) {
      expect(modules.length, tool).toBeGreaterThan(0)
    }
  })
})
