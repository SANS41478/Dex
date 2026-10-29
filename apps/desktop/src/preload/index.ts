import { contextBridge, ipcRenderer } from 'electron'

async function invokeSession<T>(channel: string, payload?: unknown): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, payload)
  if (raw === null || typeof raw !== 'object') throw new Error('会话服务返回无效响应')
  const value = raw as { ok?: unknown; result?: unknown; error?: { message?: unknown } }
  if (value.ok !== true) {
    const message =
      value.error !== undefined && typeof value.error.message === 'string'
        ? value.error.message
        : '会话服务请求失败'
    throw new Error(message)
  }
  return value.result as T
}

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
  },
  window: {
    minimize: () => ipcRenderer.invoke('dex.window.minimize'),
    toggleMaximize: () => ipcRenderer.invoke('dex.window.toggleMaximize'),
    close: () => ipcRenderer.invoke('dex.window.close'),
    isMaximized: () => ipcRenderer.invoke('dex.window.isMaximized'),
  },
  models: {
    list: (sessionId?: string) => ipcRenderer.invoke('dex.models.list', sessionId),
    select: (sessionId: string, selection: unknown) =>
      ipcRenderer.invoke('dex.models.select', { sessionId, selection }),
    discover: (input: unknown) => ipcRenderer.invoke('dex.models.discover', input),
    setCredential: (provider: string, apiKey: string) =>
      ipcRenderer.invoke('dex.models.setCredential', { provider, apiKey }),
    unsetCredential: (provider: string) =>
      ipcRenderer.invoke('dex.models.unsetCredential', provider),
  },
  sessions: {
    list: (cursor?: string) => ipcRenderer.invoke('dex.sessions.list', cursor),
    replay: (sessionId: string) => ipcRenderer.invoke('dex.sessions.replay', sessionId),
    rename: (input: unknown) => ipcRenderer.invoke('dex.sessions.rename', input),
    archive: (input: unknown) => ipcRenderer.invoke('dex.sessions.archive', input),
    unarchive: (sessionId: string) => ipcRenderer.invoke('dex.sessions.unarchive', sessionId),
    delete: (sessionId: string) => ipcRenderer.invoke('dex.sessions.delete', sessionId),
    pin: (sessionId: string) => ipcRenderer.invoke('dex.sessions.pin', sessionId),
    unpin: (sessionId: string) => ipcRenderer.invoke('dex.sessions.unpin', sessionId),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('dex.workspaces.list'),
    create: (path: string) => ipcRenderer.invoke('dex.workspaces.create', path),
    rename: (input: unknown) => ipcRenderer.invoke('dex.workspaces.rename', input),
    delete: (workspaceId: string) => ipcRenderer.invoke('dex.workspaces.delete', workspaceId),
    insertBefore: (input: unknown) => ipcRenderer.invoke('dex.workspaces.insertBefore', input),
  },
  settings: {
    describe: () => ipcRenderer.invoke('dex.settings.describe'),
    mutate: (input: unknown) => ipcRenderer.invoke('dex.settings.mutate', input),
  },
  plugins: {
    list: () => ipcRenderer.invoke('dex.plugins.list'),
    setEnabled: (input: unknown) => ipcRenderer.invoke('dex.plugins.setEnabled', input),
  },
  workspace: {
    pick: () => invokeSession('dex.workspace.pick'),
    pickFiles: () => invokeSession('dex.workspace.pickFiles'),
  },
  session: {
    create: (input: unknown) => invokeSession('dex.session.create', input),
    activate: (input: unknown) => invokeSession('dex.session.activate', input),
    prompt: (input: unknown) => invokeSession('dex.session.prompt', input),
    stop: (sessionId: string) => invokeSession('dex.session.stop', { sessionId }),
  },
  snapshot: {
    save: (payload: unknown) => ipcRenderer.invoke('dex.snapshot.save', payload),
  },
} as const

contextBridge.exposeInMainWorld('dex', api)
