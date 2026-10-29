import { type BrowserWindow, ipcMain } from 'electron'

export function registerWindowIpc(getWindow: () => BrowserWindow | null): () => void {
  const minimize = 'dex.window.minimize'
  const toggleMaximize = 'dex.window.toggleMaximize'
  const close = 'dex.window.close'
  const isMaximized = 'dex.window.isMaximized'

  ipcMain.handle(minimize, () => {
    getWindow()?.minimize()
    return { ok: true }
  })
  ipcMain.handle(toggleMaximize, () => {
    const window = getWindow()
    if (window === null) return { ok: false }
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return { ok: true, maximized: window.isMaximized() }
  })
  ipcMain.handle(close, () => {
    getWindow()?.close()
    return { ok: true }
  })
  ipcMain.handle(isMaximized, () => ({ maximized: getWindow()?.isMaximized() ?? false }))

  return () => {
    ipcMain.removeHandler(minimize)
    ipcMain.removeHandler(toggleMaximize)
    ipcMain.removeHandler(close)
    ipcMain.removeHandler(isMaximized)
  }
}
