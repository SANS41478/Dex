import { z } from 'zod'

/**
 * 推理档位（reasoning effort）的取值域。
 *
 * `off` 是**安全默认**：它表示「不把 `reasoningEffort` 参数发给网关」，由模型/网关
 * 自行决定推理强度。选具体档位（minimal…high）等于**替模型做决定**，而模型是否支持
 * 某个档位我们并不总是知道——发错档位时 dsh 会整轮失败（`UNSUPPORTED_REASONING_EFFORT`）。
 */
export const reasoningEfforts = ['off', 'minimal', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof reasoningEfforts)[number]

export const reasoningEffortSchema = z.enum(reasoningEfforts)

/**
 * provider/model → 该模型**真正支持**的推理档位。
 *
 * **为什么要有这张表**：dsh 的模型目录协议不带档位能力信息，
 * 界面过去只能硬编码全部五档，于是「默认 medium + 默认模型 deepseek-flash」必炸——
 * 外部黑盒报告 D01 记的就是这一条：turn 在 2~6ms 内以
 * `UNSUPPORTED_REASONING_EFFORT` 结束，而界面毫无反馈。
 *
 * **查不到就是未知**：按「全档位可用」处理，不擅自降级（保持既有行为，
 * 免得把用户明确选的档位悄悄改掉）。只登记已确证的约束。
 *
 * **键的匹配顺序**：`provider/model` → `provider/*` → `*`。
 */
const CAPABILITY_TABLE: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  // 实测证据（2026-10-07，真实宿主 `pnpm dev` + 真实凭据）：
  //   provider "deepseek-official" model "deepseek-flash"   → 拒绝 "medium"
  //   provider "deepseek-official" model "deepseek-v4-pro"  → 同样拒绝 "medium"
  // 两个模型都只确认了 `off` 可用（`off` = 不带 `reasoningEffort`，交给网关默认）。
  // 因此按**整个 provider 路由**收敛，而不是只特判 flash：曾经默认 `medium` 就死在这里
  // （黑盒报告 D01）。等 dsh 的模型目录带上档位能力（`TECH-06`）后，这张表应当整体删除。
  'deepseek-official/*': ['off'],
}

/** 该 provider/model 支持的档位；未知组合返回全档位。 */
export function reasoningEffortsFor(
  provider: string | undefined,
  model: string | undefined,
): readonly ReasoningEffort[] {
  if (provider === undefined || model === undefined) return reasoningEfforts
  return (
    CAPABILITY_TABLE[`${provider}/${model}`] ??
    CAPABILITY_TABLE[`${provider}/*`] ??
    CAPABILITY_TABLE['*'] ??
    reasoningEfforts
  )
}

/** 某档位在该模型上是否可用（未知模型恒 true）。 */
export function isReasoningEffortSupported(
  provider: string | undefined,
  model: string | undefined,
  effort: string,
): boolean {
  const allowed = reasoningEffortsFor(provider, model)
  return allowed.some((candidate) => candidate === effort)
}

/**
 * 把「想要的档位」收敛成「该模型真能接受的档位」，作为**发送边界的兜底**。
 *
 * 降级规则：能原样用就原样用；否则取**不超过该档位**的最高可用档；再没有就取最低可用档。
 * 例：`deepseek-flash` + `medium` → `off`（唯一可用档）。
 *
 * 界面侧已经把不支持的档位置灰（`Composer`），这里是防手滑与防协议绕过的第二道闸。
 */
export function resolveReasoningEffort(
  provider: string | undefined,
  model: string | undefined,
  desired: string,
): ReasoningEffort {
  const allowed = reasoningEffortsFor(provider, model)
  if (allowed.some((candidate) => candidate === desired)) return desired as ReasoningEffort
  const limit = reasoningEfforts.indexOf(desired as ReasoningEffort)
  const notAbove = allowed.filter((candidate) => reasoningEfforts.indexOf(candidate) <= limit)
  return notAbove.at(-1) ?? allowed[0] ?? 'off'
}
