import { describe, expect, it } from 'vitest'
import { sessionIdsOfWorkspace } from './workspaceActions'

describe('sessionIdsOfWorkspace', () => {
  const workspace = { id: 'workspace:e:/ws', path: 'e:/ws' }

  it('合并 cwd 归属、本地别名与宿主成员，并去重', () => {
    const ids = sessionIdsOfWorkspace({
      workspace,
      sessions: [
        { sessionId: 'by-cwd', cwd: 'E:/WS' },
        { sessionId: 'by-alias' },
        { sessionId: 'other', cwd: 'E:/other' },
      ],
      sessionWorkspace: { 'by-alias': workspace.id },
      hostSessionIds: ['by-cwd', 'host-only'],
    })

    expect(ids).toEqual(expect.arrayContaining(['by-cwd', 'by-alias', 'host-only']))
    expect(ids).not.toContain('other')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('只把属于该工作区的当前会话算进来', () => {
    expect(
      sessionIdsOfWorkspace({
        workspace,
        sessions: [],
        sessionWorkspace: {},
        activeSessionId: 'active',
        activeWorkspacePath: 'E:/ws',
      }),
    ).toEqual(['active'])
    expect(
      sessionIdsOfWorkspace({
        workspace,
        sessions: [],
        sessionWorkspace: {},
        activeSessionId: 'active',
        activeWorkspacePath: 'E:/other',
      }),
    ).toEqual([])
  })

  it('本地空白会话按工作区路径归入', () => {
    expect(
      sessionIdsOfWorkspace({
        workspace,
        sessions: [],
        sessionWorkspace: {},
        activeSessionId: 'blank',
        localBlankWorkspacePaths: ['E:/ws'],
      }),
    ).toEqual(['blank'])
  })
})
