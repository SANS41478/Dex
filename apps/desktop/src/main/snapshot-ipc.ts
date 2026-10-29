import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import { dialog, ipcMain } from 'electron'
import { z } from 'zod'

const snapshotPayloadSchema = z.object({
  suggestedName: z.string().regex(/^dex-graph-\d{8}-\d{6}\.(json|png)$/),
  mime: z.enum(['application/json', 'image/png']),
  data: z
    .string()
    .min(1)
    .max(25 * 1024 * 1024),
})

export function registerSnapshotIpc(): () => void {
  const channel = 'dex.snapshot.save'
  ipcMain.handle(channel, async (_event, raw: unknown) => {
    const payload = snapshotPayloadSchema.parse(raw)
    const extension = extname(payload.suggestedName)
    if (
      (payload.mime === 'application/json' && extension !== '.json') ||
      (payload.mime === 'image/png' && extension !== '.png')
    ) {
      throw new Error('快照文件扩展名与 MIME 类型不匹配')
    }
    const result = await dialog.showSaveDialog({
      defaultPath: basename(payload.suggestedName),
      filters: [
        payload.mime === 'application/json'
          ? { name: 'JSON', extensions: ['json'] }
          : { name: 'PNG', extensions: ['png'] },
      ],
    })
    if (result.canceled || result.filePath === undefined) return { canceled: true }
    const bytes =
      payload.mime === 'image/png'
        ? Buffer.from(payload.data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : Buffer.from(payload.data, 'utf8')
    await fs.writeFile(result.filePath, bytes)
    return { canceled: false, path: result.filePath }
  })
  return () => {
    ipcMain.removeHandler(channel)
  }
}
