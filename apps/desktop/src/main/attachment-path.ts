import * as nodePath from 'node:path'

export function relativeAttachment(workspacePath: string, attachmentPath: string): string | null {
  const windowsStyle =
    /^[A-Za-z]:[\\/]/.test(workspacePath) || /^[A-Za-z]:[\\/]/.test(attachmentPath)
  const pathApi = windowsStyle ? nodePath.win32 : nodePath
  const root = pathApi.resolve(workspacePath)
  const absolute = pathApi.isAbsolute(attachmentPath)
    ? pathApi.resolve(attachmentPath)
    : pathApi.resolve(root, attachmentPath)
  const relativePath = pathApi.relative(root, absolute)
  if (relativePath === '' || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) {
    return null
  }
  return relativePath.replaceAll('\\', '/')
}
