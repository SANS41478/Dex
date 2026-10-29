import { describe, expect, it } from 'vitest'
import {
  isApprovalPolicySupported,
  isPermissionPresetSupported,
  runtimePolicyNotice,
} from './policy'

describe('runtime 支持的权限 / 审批档位', () => {
  it('当前 runtime 只认 workspace-write 与 ask', () => {
    expect(isPermissionPresetSupported('workspace-write')).toBe(true)
    expect(isPermissionPresetSupported('read-only')).toBe(false)
    expect(isPermissionPresetSupported('danger-full-access')).toBe(false)
    expect(isApprovalPolicySupported('ask')).toBe(true)
    expect(isApprovalPolicySupported('never')).toBe(false)
  })

  it('支持的档位不产生说明', () => {
    expect(
      runtimePolicyNotice({ permissionPreset: 'workspace-write', approvalPolicy: 'ask' }),
    ).toBeNull()
    expect(runtimePolicyNotice({})).toBeNull()
  })

  it('不支持的档位生成降级说明（降级但不静默）', () => {
    const notice = runtimePolicyNotice({ permissionPreset: 'read-only' })
    expect(notice).toContain('read-only')
    expect(notice).toContain('workspace-write')
  })

  it('多个档位同时降级时合并成一条', () => {
    const notice = runtimePolicyNotice({ permissionPreset: 'read-only', approvalPolicy: 'never' })
    expect(notice?.split('；')).toHaveLength(2)
  })
})
