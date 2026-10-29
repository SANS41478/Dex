export interface DexApi {
  platform: string
  versions: {
    electron: string
  }
  window: {
    minimize: () => Promise<unknown>
    /**
     * 主进程返回的是**切换后的真实状态**，渲染层据此同步按钮的可访问名
     * （「最大化」⇄「还原」）。过去这里返回 `unknown`，界面只能靠猜，
     * 于是标签永远停在「最大化」（黑盒报告 D12/D16）。
     */
    toggleMaximize: () => Promise<{ ok: boolean; maximized?: boolean }>
    close: () => Promise<unknown>
    isMaximized: () => Promise<{ maximized: boolean }>
  }
  models: {
    list: (sessionId?: string) => Promise<unknown>
    select: (sessionId: string, selection: unknown) => Promise<unknown>
    discover: (input: unknown) => Promise<unknown>
    setCredential: (provider: string, apiKey: string) => Promise<unknown>
    unsetCredential: (provider: string) => Promise<unknown>
  }
  sessions: {
    list: (cursor?: string) => Promise<unknown>
    replay: (sessionId: string) => Promise<unknown>
    rename: (input: unknown) => Promise<unknown>
    archive: (input: unknown) => Promise<unknown>
    unarchive: (sessionId: string) => Promise<unknown>
    delete: (sessionId: string) => Promise<unknown>
    pin: (sessionId: string) => Promise<unknown>
    unpin: (sessionId: string) => Promise<unknown>
  }
  workspaces: {
    list: () => Promise<unknown>
    create: (path: string) => Promise<unknown>
    rename: (input: unknown) => Promise<unknown>
    delete: (workspaceId: string) => Promise<unknown>
    insertBefore: (input: unknown) => Promise<unknown>
  }
  settings: {
    describe: () => Promise<unknown>
    mutate: (input: unknown) => Promise<unknown>
  }
  plugins: {
    list: () => Promise<unknown>
    setEnabled: (input: unknown) => Promise<unknown>
  }
  workspace: {
    pick: () => Promise<unknown>
    pickFiles: () => Promise<unknown>
  }
  session: {
    create: (input: unknown) => Promise<unknown>
    activate: (input: unknown) => Promise<unknown>
    prompt: (input: unknown) => Promise<unknown>
    stop: (sessionId: string) => Promise<unknown>
  }
  snapshot: {
    save: (payload: unknown) => Promise<unknown>
  }
}

declare global {
  interface Window {
    dex: DexApi
  }
}
