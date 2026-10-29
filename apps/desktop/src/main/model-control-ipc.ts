import { modelDiscoveryRequestSchema, settingsMutateRequestSchema } from '@dexagent/shared'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { type ModelControlClient, ModelControlError } from './model-control-client'

const sessionIdSchema = z.string().min(1).optional()
const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})
const providerSchema = z.string().min(1)
const apiKeySchema = z.string().min(1)

/**
 * 控制面写操作的统一应答：`{ok:true,result}` / `{ok:false,error:{code,message,retryable}}`。
 * 结构化错误是硬规则 8 的要求；UI 据 `code` 分支（如 `SESSION_ACTIVE` → 「停止并归档」确认框）。
 */
function respond<T>(action: () => Promise<T>) {
  return action().then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => {
      if (error instanceof ModelControlError) {
        return {
          ok: false as const,
          error: { code: error.code, message: error.message, retryable: error.retryable },
        }
      }
      return {
        ok: false as const,
        error: {
          code: 'CONTROL_FAILED',
          message: error instanceof Error ? error.message : '控制请求失败',
          retryable: false,
        },
      }
    },
  )
}

export function registerModelControlIpc(client: ModelControlClient): () => void {
  const list = 'dex.models.list'
  const select = 'dex.models.select'
  const discover = 'dex.models.discover'
  const setCredential = 'dex.models.setCredential'
  const unsetCredential = 'dex.models.unsetCredential'
  const listSessions = 'dex.sessions.list'
  const replaySession = 'dex.sessions.replay'
  const renameSession = 'dex.sessions.rename'
  const archiveSession = 'dex.sessions.archive'
  const unarchiveSession = 'dex.sessions.unarchive'
  const deleteSession = 'dex.sessions.delete'
  const pinSession = 'dex.sessions.pin'
  const unpinSession = 'dex.sessions.unpin'
  const listWorkspaces = 'dex.workspaces.list'
  const createWorkspace = 'dex.workspaces.create'
  const renameWorkspace = 'dex.workspaces.rename'
  const deleteWorkspace = 'dex.workspaces.delete'
  const insertWorkspaceBefore = 'dex.workspaces.insertBefore'
  const describeSettings = 'dex.settings.describe'
  const mutateSettings = 'dex.settings.mutate'
  const listPlugins = 'dex.plugins.list'
  const setPluginEnabled = 'dex.plugins.setEnabled'

  ipcMain.handle(list, (_event, sessionId: unknown) =>
    client.list(sessionIdSchema.parse(sessionId)),
  )
  ipcMain.handle(select, (_event, payload: unknown) => {
    const parsed = z
      .object({ sessionId: z.string().min(1), selection: selectionSchema })
      .parse(payload)
    return client.select(parsed.sessionId, parsed.selection)
  })
  ipcMain.handle(setCredential, (_event, payload: unknown) => {
    const parsed = z.object({ provider: providerSchema, apiKey: apiKeySchema }).parse(payload)
    return client.setCredential(parsed.provider, parsed.apiKey)
  })
  ipcMain.handle(unsetCredential, (_event, provider: unknown) =>
    client.unsetCredential(providerSchema.parse(provider)),
  )
  ipcMain.handle(listSessions, (_event, cursor: unknown) =>
    client.listSessions(z.string().min(1).optional().parse(cursor)),
  )
  ipcMain.handle(replaySession, (_event, sessionId: unknown) =>
    client.replaySession(z.string().min(1).parse(sessionId)),
  )
  ipcMain.handle(discover, (_event, payload: unknown) =>
    respond(() => client.discoverModels(modelDiscoveryRequestSchema.parse(payload))),
  )
  ipcMain.handle(renameSession, (_event, payload: unknown) => {
    const parsed = z
      .object({ sessionId: z.string().min(1), title: z.string().min(1) })
      .parse(payload)
    return respond(() => client.renameSession(parsed))
  })
  ipcMain.handle(archiveSession, (_event, payload: unknown) => {
    const parsed = z
      .object({ sessionId: z.string().min(1), stopActivity: z.boolean().optional() })
      .parse(payload)
    return respond(() =>
      client.archiveSession({
        sessionId: parsed.sessionId,
        ...(parsed.stopActivity === undefined ? {} : { stopActivity: parsed.stopActivity }),
      }),
    )
  })
  ipcMain.handle(unarchiveSession, (_event, sessionId: unknown) =>
    respond(() => client.unarchiveSession(z.string().min(1).parse(sessionId))),
  )
  ipcMain.handle(deleteSession, (_event, sessionId: unknown) =>
    respond(() => client.deleteSession(z.string().min(1).parse(sessionId))),
  )
  ipcMain.handle(pinSession, (_event, sessionId: unknown) =>
    respond(() => client.pinSession(z.string().min(1).parse(sessionId))),
  )
  ipcMain.handle(unpinSession, (_event, sessionId: unknown) =>
    respond(() => client.unpinSession(z.string().min(1).parse(sessionId))),
  )
  ipcMain.handle(listWorkspaces, () => respond(() => client.listWorkspaces()))
  ipcMain.handle(createWorkspace, (_event, path: unknown) =>
    respond(() => client.createWorkspace(z.string().min(1).parse(path))),
  )
  ipcMain.handle(renameWorkspace, (_event, payload: unknown) => {
    const parsed = z
      .object({ workspaceId: z.string().min(1), title: z.string().min(1) })
      .parse(payload)
    return respond(() => client.renameWorkspace(parsed.workspaceId, parsed.title))
  })
  ipcMain.handle(deleteWorkspace, (_event, workspaceId: unknown) =>
    respond(() => client.deleteWorkspace(z.string().min(1).parse(workspaceId))),
  )
  ipcMain.handle(insertWorkspaceBefore, (_event, payload: unknown) => {
    const parsed = z
      .object({ workspaceId: z.string().min(1), beforeWorkspaceId: z.string().min(1).optional() })
      .parse(payload)
    return respond(() => client.insertWorkspaceBefore(parsed.workspaceId, parsed.beforeWorkspaceId))
  })
  ipcMain.handle(describeSettings, () => client.settingsDescribe())
  ipcMain.handle(mutateSettings, async (_event, payload: unknown) => {
    const parsed = settingsMutateRequestSchema.parse(payload)
    try {
      return { ok: true, result: await client.settingsMutate(parsed) }
    } catch (error) {
      if (error instanceof ModelControlError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, retryable: error.retryable },
        }
      }
      throw error
    }
  })
  // 与 `dex.settings.describe` 同款：直接返回结果、失败走 invoke 拒绝（调用方统一 catch）。
  ipcMain.handle(listPlugins, () => client.listPlugins())
  ipcMain.handle(setPluginEnabled, (_event, payload: unknown) => {
    const parsed = z.object({ entryId: z.string().min(1), enabled: z.boolean() }).parse(payload)
    return respond(() => client.setPluginEnabled(parsed))
  })

  return () => {
    for (const channel of [
      list,
      select,
      discover,
      setCredential,
      unsetCredential,
      listSessions,
      replaySession,
      renameSession,
      archiveSession,
      unarchiveSession,
      deleteSession,
      pinSession,
      unpinSession,
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
      insertWorkspaceBefore,
      describeSettings,
      mutateSettings,
      listPlugins,
      setPluginEnabled,
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
}
