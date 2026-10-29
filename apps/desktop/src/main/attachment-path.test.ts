import { describe, expect, it } from 'vitest'
import { relativeAttachment } from './attachment-path'

describe('relativeAttachment', () => {
  it('只接受 workspace 内的文件并归一化分隔符', () => {
    expect(relativeAttachment('C:/repo', 'C:/repo/src/app.ts')).toBe('src/app.ts')
    expect(relativeAttachment('C:/repo', 'C:/repo\\src\\app.ts')).toBe('src/app.ts')
  })

  it('拒绝 workspace 外的路径', () => {
    expect(relativeAttachment('C:/repo', 'C:/other/secret.txt')).toBeNull()
    expect(relativeAttachment('C:/repo', '../secret.txt')).toBeNull()
  })
})
