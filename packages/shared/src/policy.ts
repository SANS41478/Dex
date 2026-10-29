import { z } from 'zod'

/** 权限预设的取值域（界面下拉的全部候选，不代表 runtime 都支持）。 */
export const permissionPresets = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type PermissionPreset = (typeof permissionPresets)[number]
export const permissionPresetSchema = z.enum(permissionPresets)

/** 审批策略的取值域。 */
export const approvalPolicies = ['ask', 'never'] as const
export type ApprovalPolicy = (typeof approvalPolicies)[number]
export const approvalPolicySchema = z.enum(approvalPolicies)

/**
 * **当前 dsh runtime 实际支持的**权限预设 / 审批策略。
 *
 * 这是全仓唯一的事实源：主进程用它决定「要不要降级」（`main/session-ipc.ts`），
 * 渲染层用它决定「哪些选项要置灰」（`Composer`）。两边各写一份必然漂移——
 * 过去主进程硬编码 `!== 'workspace-write'` 直接拒绝发送，界面上却照旧把三档全部放开，
 * 用户选了必然不可用的档位、发出去只得到一句与真因无关的报错（黑盒报告 D04/D06）。
 *
 * **收敛到什么程度**：等 dsh 暴露运行时可查询的能力描述后，把这里换成从宿主读回的值；
 * 在那之前维持一张显式白名单，宁可保守也不放开通不过的档位。
 */
export const runtimeSupportedPermissionPresets: readonly PermissionPreset[] = ['workspace-write']
export const runtimeSupportedApprovalPolicies: readonly ApprovalPolicy[] = ['ask']

export function isPermissionPresetSupported(preset: string): boolean {
  return runtimeSupportedPermissionPresets.some((candidate) => candidate === preset)
}

export function isApprovalPolicySupported(policy: string): boolean {
  return runtimeSupportedApprovalPolicies.some((candidate) => candidate === policy)
}

export interface RuntimePolicyRequest {
  readonly permissionPreset?: string | undefined
  readonly approvalPolicy?: string | undefined
}

/**
 * 生成「档位被降级」的用户可读说明；没有任何降级时返回 `null`。
 *
 * 走这条路是刻意的：**降级执行但不静默**。直接拒绝发送会把真正的原因（模型不支持该
 * 推理档位、provider 缺凭据）盖在一句权限报错下面，用户被引向完全错误的方向。
 */
export function runtimePolicyNotice(input: RuntimePolicyRequest): string | null {
  const notices: string[] = []
  if (
    input.permissionPreset !== undefined &&
    !isPermissionPresetSupported(input.permissionPreset)
  ) {
    notices.push(
      `当前 runtime 不支持「${input.permissionPreset}」权限，已按「${runtimeSupportedPermissionPresets.join('、')}」执行`,
    )
  }
  if (input.approvalPolicy !== undefined && !isApprovalPolicySupported(input.approvalPolicy)) {
    notices.push(
      `当前 runtime 不支持「${input.approvalPolicy}」审批策略，已按「${runtimeSupportedApprovalPolicies.join('、')}」执行`,
    )
  }
  return notices.length === 0 ? null : notices.join('；')
}
