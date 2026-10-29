/**
 * Rings LLM Proxy provider 的**唯一来源**（迁移版）。
 *
 * 历史：该 provider 原先由 main 以 `--patch` overlay
 * 注入。但 dsh 的 patch 合并是**顶层键整体替换**（`cordis-plugin-include` 的
 * `applyEntryPatches`：`target[key] = value`，不是深合并），rings overlay 会把
 * `llm-pi-ai.config.providers` 整体覆盖，导致：
 *   ① 用户自定义 provider 永远进不了目录（B.AI 个案，FIX-021）；
 *   ② 任何经设置界面的 provider 写入都会被写保护拒绝（"overridden by overlay"）。
 * 因此自 2026-10-07 起改为：**桥接插件在宿主启动时把 rings 作为普通 user 层设置
 * 播种**（`settings.mutate('llm-pi-ai', [{op:'set', path:['providers','rings'], value}]`），
 * 与其他 provider 同一张表、同一套读写路径，可被用户在设置里编辑/删除。
 *
 * `DEX_ENABLE_RINGS=0` 仍然表示「不播种」（不再有 patch 可跳过）。
 */
import type { JsonValue } from '@dexagent/shared'

export function ringsProviderProfile(env: NodeJS.ProcessEnv = process.env): JsonValue {
  const baseURL = env.RINGS_BASE_URL?.trim() || 'https://api.ten-rings.adtensor.com/llm/v1'
  const modelId = env.RINGS_MODEL?.trim() || 'gpt-6-luna'
  const profile: { [key: string]: JsonValue } = {
    displayName: 'Rings GPT-6 Luna',
    apiKeyEnv: 'RINGS_API_KEY',
    api: 'openai-completions',
    baseURL,
    models: [
      {
        id: modelId,
        name: 'GPT-6 Luna',
        // 键的合法集合由 dsh schema 限死（off|minimal|low|medium|high|xhigh|max）；
        // `minimal` 在 rings 网关是 400，故降级映射为 low（M4-03 实测）。
        reasoningEfforts: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high' },
      },
    ],
  }
  return profile
}
