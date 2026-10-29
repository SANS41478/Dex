import { describe, expect, it } from 'vitest'
import {
  emptyWorkspaceIndex,
  linkSessionToWorkspace,
  normalizeWorkspacePath,
  parseActiveWorkspaceId,
  registerWorkspace,
  serializeActiveWorkspaceId,
  workspaceForSession,
} from './workspaces'

describe('workspace registry', () => {
  it('规范化路径并按路径去重', () => {
    expect(normalizeWorkspacePath('C:\\Projects\\Dex\\')).toBe('c:/projects/dex')
    const first = registerWorkspace(emptyWorkspaceIndex, 'C:\\Projects\\Dex\\', 1)
    const second = registerWorkspace(first.index, 'c:/projects/dex', 2)
    expect(second.index.workspaces).toHaveLength(1)
    expect(second.workspace.id).toBe(first.workspace.id)
    expect(second.workspace.lastUsedAt).toBe(2)
  })

  it('保存会话到工作区并可反查', () => {
    const registered = registerWorkspace(emptyWorkspaceIndex, '/repo', 1)
    const linked = linkSessionToWorkspace(registered.index, 'session-1', registered.workspace)
    expect(workspaceForSession(linked, 'session-1')).toEqual(registered.workspace)
    expect(workspaceForSession(linked, 'missing')).toBeNull()
  })
})

describe('激活工作区持久化', () => {
  it('合法 id 原样解析，序列化可回读', () => {
    const { workspace } = registerWorkspace(emptyWorkspaceIndex, '/repo', 1)
    const raw = serializeActiveWorkspaceId(workspace.id)
    expect(parseActiveWorkspaceId(raw, [workspace])).toBe(workspace.id)
    expect(parseActiveWorkspaceId(serializeActiveWorkspaceId(null), [workspace])).toBeNull()
  })

  it('指向已消失工作区的 id 回退 null', () => {
    const raw = serializeActiveWorkspaceId('workspace:gone')
    expect(parseActiveWorkspaceId(raw, [])).toBeNull()
  })

  it('非法载荷（非 JSON、非字符串、空串）回退 null', () => {
    const registered = registerWorkspace(emptyWorkspaceIndex, '/repo', 1)
    expect(parseActiveWorkspaceId('{broken', registered.index.workspaces)).toBeNull()
    expect(parseActiveWorkspaceId('123', registered.index.workspaces)).toBeNull()
    expect(parseActiveWorkspaceId('', registered.index.workspaces)).toBeNull()
    expect(parseActiveWorkspaceId(null, registered.index.workspaces)).toBeNull()
  })
})
