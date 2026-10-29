import type { ModelCatalog, ModelSelection } from '@dexagent/shared'

/**
 * 挑一个「默认模型选择」，供新建 / 恢复会话时随请求一起提交。
 *
 * **为什么必须有这一步**：dsh 的 `models/select` 协议**强制要求 `sessionId`**
 * （见 `packages/bridges/src/plugins/model-control.ts`），所以「没有会话」等价于
 * 「没有模型选择」。而用户在设置里填完 API key 之后，界面上没有任何「接入成功」的
 * 迹象——底部工具栏的模型下拉是灰的（`disabled = activeSessionId === null`），
 * 发消息也没有模型可用。用户的读法是「接入失败」，实际只是缺一次「选一个」，
 * 而这一次还偏偏只能在有会话之后才能做。
 *
 * 选择顺序：
 * 1. 目录里已有的选择（用户上次选过的，切换会话 / 新建时沿用）；
 * 2. 第一个**凭据已配置**的 provider 的首个模型——有 key 的那个才是用户真正想用的，
 *    刚填完 key 的场景下这一步就能把「接入」真正落到实处；
 * 3. 全都没配凭据时退回列出的第一个 provider，至少让流程能走下去（后续会由
 *    provider 侧报出「未配置凭据」，比界面静默无反应更好定位）。
 */
export function pickDefaultSelection(catalog: ModelCatalog): ModelSelection | null {
  if (catalog.selection !== null) return catalog.selection
  const configured = catalog.providers.find((provider) => provider.credential.configured)
  const provider = configured ?? catalog.providers[0]
  const model = provider?.models[0]
  if (provider === undefined || model === undefined) return null
  return { provider: provider.id, model: model.id }
}
