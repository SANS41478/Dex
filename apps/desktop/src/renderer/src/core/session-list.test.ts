import type { SessionSummary } from '@dexagent/shared'
import { describe, expect, it } from 'vitest'
import {
  deriveSessionStatus,
  findReusableBlankSession,
  groupSessionsByWorkspace,
  selectVisibleSessions,
  synthesizeActiveSession,
} from './session-list'
import { UNGROUPED_ORDER_KEY } from './sidebar-order'
import type { TurnRecord } from './trace'
import { registerWorkspace, type WorkspaceIndex } from './workspaces'

function turn(id: string, status: TurnRecord['status'], endedAt?: number): TurnRecord {
  return {
    id,
    userMessage: '',
    status,
    startedAt: 0,
    steps: [],
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    title: `会话 ${sessionId}`,
    status: 'completed',
    taskCount: 1,
    updatedAt: 0,
    ...overrides,
  }
}

const emptyIndex = { pinned: [], hidden: [] }
const emptyWorkspaceIndex: WorkspaceIndex = { workspaces: [], sessionWorkspace: {} }

describe('deriveSessionStatus', () => {
  it('末轮 failed → failed；completed → completed；无轮次/running → running', () => {
    expect(deriveSessionStatus([turn('s:t1', 'failed')])).toBe('failed')
    expect(deriveSessionStatus([turn('s:t1', 'running'), turn('s:t2', 'completed', 5)])).toBe(
      'completed',
    )
    expect(deriveSessionStatus([])).toBe('running')
    expect(deriveSessionStatus([turn('s:t1', 'running')])).toBe('running')
  })
})

describe('findReusableBlankSession', () => {
  const registered = registerWorkspace(emptyWorkspaceIndex, 'C:\\repo', 1)
  const sessions = [summary('blank', { blank: true }), summary('used', { blank: false })]
  const linked = { blank: registered.workspace.id, used: registered.workspace.id }

  it('只返回属于同一工作区的空会话', () => {
    expect(
      findReusableBlankSession({
        sessions,
        sessionWorkspace: linked,
        workspaceId: registered.workspace.id,
        workspacePath: 'c:/repo/',
      })?.sessionId,
    ).toBe('blank')
  })

  it('工作区成员关系、路径或 blank 条件任一不符都不复用', () => {
    expect(
      findReusableBlankSession({
        sessions,
        sessionWorkspace: {},
        workspaceId: registered.workspace.id,
        workspacePath: registered.workspace.path,
      }),
    ).toBeNull()
    expect(
      findReusableBlankSession({
        sessions,
        sessionWorkspace: linked,
        workspaceId: registered.workspace.id,
        workspacePath: 'C:/other',
      }),
    ).toBeNull()
    expect(
      findReusableBlankSession({
        sessions: [summary('used', { blank: false })],
        sessionWorkspace: linked,
        workspaceId: registered.workspace.id,
        workspacePath: registered.workspace.path,
      }),
    ).toBeNull()
  })

  it('cwd 与工作区路径相等即可复用（归属权威是 cwd，不依赖本地别名）', () => {
    expect(
      findReusableBlankSession({
        sessions: [summary('blank', { blank: true, cwd: 'C:/repo' })],
        sessionWorkspace: {},
        workspaceId: registered.workspace.id,
        workspacePath: registered.workspace.path,
      })?.sessionId,
    ).toBe('blank')
  })

  it('cwd 指向别处时本地别名也不能救回（cwd 优先，FIX-018 语义）', () => {
    expect(
      findReusableBlankSession({
        sessions: [summary('blank', { blank: true, cwd: 'C:/other' })],
        sessionWorkspace: { blank: registered.workspace.id },
        workspaceId: registered.workspace.id,
        workspacePath: registered.workspace.path,
      }),
    ).toBeNull()
  })

  it('无 cwd 的空白会话按本地别名复用', () => {
    expect(
      findReusableBlankSession({
        sessions: [summary('blank', { blank: true })],
        sessionWorkspace: linked,
        workspaceId: registered.workspace.id,
        workspacePath: registered.workspace.path,
      })?.sessionId,
    ).toBe('blank')
  })
})

describe('selectVisibleSessions', () => {
  const sessions = [
    summary('b', { title: 'Beta', updatedAt: 2 }),
    summary('a', { title: 'Alpha', updatedAt: 1 }),
    summary('b', { title: 'Beta 重复', updatedAt: 9 }),
    summary('c', { title: 'Gamma', updatedAt: 3 }),
  ]

  it('按 sessionId 去重（保留后出现者）', () => {
    const result = selectVisibleSessions({ sessions, index: emptyIndex })
    expect(result.map((item) => item.sessionId)).toEqual(['b', 'c', 'a'])
    expect(result[0]?.title).toBe('Beta 重复')
  })

  it('遗留 hidden 不再参与过滤（会话不会再永久消失）', () => {
    const result = selectVisibleSessions({ sessions, index: { pinned: [], hidden: ['c'] } })
    expect(result.map((item) => item.sessionId)).toContain('c')
  })

  it('查询词匹配标题或 id（大小写不敏感）', () => {
    const byTitle = selectVisibleSessions({ sessions, index: emptyIndex, query: 'alph' })
    expect(byTitle.map((item) => item.sessionId)).toEqual(['a'])
    const byId = selectVisibleSessions({ sessions, index: emptyIndex, query: 'C' })
    expect(byId.map((item) => item.sessionId)).toEqual(['c'])
  })

  it('置顶优先，其余按 updatedAt 降序', () => {
    const result = selectVisibleSessions({
      sessions,
      index: { pinned: ['a'], hidden: [] },
    })
    expect(result.map((item) => item.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('空白会话只留当前那条（无活跃会话则全部不显示）', () => {
    const withBlanks = [
      summary('blank-a', { blank: true }),
      summary('blank-b', { blank: true }),
      summary('used', { blank: false }),
    ]
    expect(
      selectVisibleSessions({
        sessions: withBlanks,
        index: emptyIndex,
        activeSessionId: 'blank-b',
      }).map((item) => item.sessionId),
    ).toEqual(['blank-b', 'used'])
    expect(
      selectVisibleSessions({ sessions: withBlanks, index: emptyIndex }).map(
        (item) => item.sessionId,
      ),
    ).toEqual(['used'])
  })

  it('搜索时空白会话全部排除（包括当前那条）', () => {
    const withBlank = [
      summary('blank-a', { blank: true, title: '新会话' }),
      summary('used', { title: 'Beta' }),
    ]
    expect(
      selectVisibleSessions({
        sessions: withBlank,
        index: emptyIndex,
        query: '新会话',
        activeSessionId: 'blank-a',
      }),
    ).toEqual([])
  })
})

describe('groupSessionsByWorkspace', () => {
  const registered = registerWorkspace(emptyWorkspaceIndex, '/repo', 1)
  const workspace = registered.workspace
  const registeredList = [workspace]
  const sessionWorkspace = { 's-1': workspace.id }

  it('cwd 与工作区路径相等 → 归属该工作区（不再依赖本地索引）', () => {
    const visible = [summary('s-1', { cwd: '/repo' })]
    const { groups, unassigned } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace: {},
    })
    expect(groups[0]?.workspace.id).toBe(workspace.id)
    expect(groups[0]?.sessions.map((item) => item.sessionId)).toEqual(['s-1'])
    expect(unassigned).toEqual([])
  })

  it('cwd 指向未知目录时推导出新的工作区分组（不落盘，命名取路径最后一段）', () => {
    const visible = [summary('s-2', { cwd: '/other/dir', updatedAt: 5 })]
    const { groups, unassigned } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace: {},
    })
    expect(unassigned).toEqual([])
    const derived = groups.find((group) => group.workspace.path === '/other/dir')
    expect(derived?.workspace.name).toBe('dir')
    expect(derived?.sessions.map((item) => item.sessionId)).toEqual(['s-2'])
    // 已登记的工作区仍要出现（空分组也要能被「新对话」用）
    expect(groups.some((group) => group.workspace.id === workspace.id)).toBe(true)
  })

  it('推导工作区的标题用原始 cwd 的大小写（Windows 路径规范化会转小写）', () => {
    const visible = [summary('s-3', { cwd: 'E:/dexAgent' })]
    const { groups } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace: {},
    })
    const derived = groups.find((group) => group.workspace.path === 'e:/dexagent')
    expect(derived?.workspace.name).toBe('dexAgent')
  })

  it('cwd 缺失且无本地别名 → 真孤儿进 unassigned', () => {
    const { unassigned } = groupSessionsByWorkspace({
      visible: [summary('s-orphan')],
      registered: registeredList,
      sessionWorkspace: {},
    })
    expect(unassigned.map((item) => item.sessionId)).toEqual(['s-orphan'])
  })

  it('cwd 缺失但本地别名存在 → 按别名归组（overlay 降级为别名）', () => {
    const visible = [summary('s-1')]
    const { groups, unassigned } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace,
    })
    expect(unassigned).toEqual([])
    expect(groups[0]?.sessions.map((item) => item.sessionId)).toEqual(['s-1'])
  })

  it('cwd 与别名冲突时以 cwd 为准（cwd 是 dsh 的归属事实）', () => {
    const visible = [summary('s-1', { cwd: '/other/dir' }), summary('s-2', { cwd: '/other/dir' })]
    const { groups } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace,
    })
    const derived = groups.find((group) => group.workspace.path === '/other/dir')
    expect(derived?.sessions.map((item) => item.sessionId)).toEqual(['s-1', 's-2'])
    expect(groups.find((group) => group.workspace.id === workspace.id)?.sessions).toEqual([])
  })

  it('查询词过滤工作区（名称/路径），真孤儿不受工作区查询影响', () => {
    const hit = groupSessionsByWorkspace({
      visible: [summary('s-orphan')],
      registered: registeredList,
      sessionWorkspace: {},
      query: 'repo',
    })
    // /repo 命中查询所以分组还在（只是空的），但孤儿不参与工作区查询
    expect(hit.groups.map((group) => group.workspace.path)).toEqual(['/repo'])
    expect(hit.groups[0]?.sessions).toEqual([])
    expect(hit.unassigned).toHaveLength(1)
    const miss = groupSessionsByWorkspace({
      visible: [summary('s-1', { cwd: '/repo' })],
      registered: registeredList,
      sessionWorkspace: {},
      query: 'no-such-workspace',
    })
    expect(miss.groups).toHaveLength(0)
    expect(miss.unassigned).toEqual([])
  })

  it('有手动顺序时按对账结果排序：保存顺序优先，新成员按最近使用补位', () => {
    const visible = [
      summary('s-1', { cwd: '/repo', updatedAt: 10 }),
      summary('s-2', { cwd: '/repo', updatedAt: 30 }),
      summary('s-3', { cwd: '/repo', updatedAt: 20 }),
    ]
    const { groups } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace: {},
      orderByAccount: { [workspace.id]: ['s-3', 's-1'] },
    })
    expect(groups[0]?.sessions.map((item) => item.sessionId)).toEqual(['s-3', 's-1', 's-2'])
  })

  it('手动顺序下未入保存顺序的置顶成员插到最前（已在保存顺序里的保持原位）', () => {
    const visible = [
      summary('s-1', { cwd: '/repo', updatedAt: 10 }),
      summary('s-2', { cwd: '/repo', updatedAt: 30 }),
    ]
    const { groups } = groupSessionsByWorkspace({
      visible,
      registered: registeredList,
      sessionWorkspace: {},
      orderByAccount: { [workspace.id]: ['s-1'] },
      pinnedIds: ['s-2'],
    })
    expect(groups[0]?.sessions.map((item) => item.sessionId)).toEqual(['s-2', 's-1'])
  })

  it('未分组桶的手动顺序走 `__ungrouped__` 账号', () => {
    const visible = [summary('o-1', { updatedAt: 1 }), summary('o-2', { updatedAt: 2 })]
    const { unassigned } = groupSessionsByWorkspace({
      visible,
      registered: [],
      sessionWorkspace: {},
      orderByAccount: { [UNGROUPED_ORDER_KEY]: ['o-2', 'o-1'] },
    })
    expect(unassigned.map((item) => item.sessionId)).toEqual(['o-2', 'o-1'])
  })

  it('活跃会话未入库时合成一条插入所属分组头部', () => {
    const { groups } = groupSessionsByWorkspace({
      visible: [],
      registered: registeredList,
      sessionWorkspace: { ...sessionWorkspace, 's-live': workspace.id },
      activeSessionId: 's-live',
      activeTurns: [turn('s-live:t1', 'running'), turn('s-live:t2', 'failed')],
    })
    const synthesized = groups[0]?.sessions.at(0)
    expect(synthesized).toMatchObject({
      sessionId: 's-live',
      title: '当前会话',
      status: 'failed',
      taskCount: 2,
    })
  })

  it('活跃会话不属于该工作区或已在列表时不再合成', () => {
    const noMatch = groupSessionsByWorkspace({
      visible: [],
      registered: registeredList,
      sessionWorkspace: {},
      activeSessionId: 's-live',
      activeTurns: [],
    })
    expect(noMatch.groups[0]?.sessions).toHaveLength(0)
    const already = groupSessionsByWorkspace({
      visible: [summary('s-1', { cwd: '/repo' })],
      registered: registeredList,
      sessionWorkspace,
      activeSessionId: 's-1',
      activeTurns: [],
    })
    expect(already.groups[0]?.sessions).toHaveLength(1)
  })
})

describe('synthesizeActiveSession', () => {
  it('completed 末轮把 endedAt 透传为 updatedAt', () => {
    const result = synthesizeActiveSession({
      activeSessionId: 's-live',
      turns: [turn('s-live:t1', 'completed', 42)],
      existing: [],
      workspaceId: 'workspace:/repo',
      sessionWorkspace: { 's-live': 'workspace:/repo' },
    })
    expect(result?.updatedAt).toBe(42)
    expect(result?.status).toBe('completed')
    expect(result?.blank).toBe(false)
  })

  it('无轮次时是「新会话」占位行（blank: true）', () => {
    const result = synthesizeActiveSession({
      activeSessionId: 's-live',
      turns: [],
      existing: [],
      workspaceId: 'workspace:/repo',
      sessionWorkspace: { 's-live': 'workspace:/repo' },
    })
    expect(result).toMatchObject({ title: '新会话', blank: true, taskCount: 0 })
    expect(result?.updatedAt).toBeUndefined()
  })
})
