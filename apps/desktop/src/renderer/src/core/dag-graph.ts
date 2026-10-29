import {
  describeStepAction,
  describeToolCall,
  summarizeThinking,
  turnOrdinal,
} from './step-summary'
import type { StepRecord, TurnRecord } from './trace'

/** DAG 节点三类：轮次 / 步骤 / 工具调用。 */
export type DagNodeKind = 'turn' | 'step' | 'tool'

export type DagNodeStatus = 'pending' | 'running' | 'ok' | 'error'

/** 归一化状态色调用域（UI 只认这四态）。 */
export type DagStatusTone = 'pending' | 'running' | 'ok' | 'error'

export function statusTone(status: string): DagStatusTone {
  if (status === 'running') return 'running'
  if (status === 'success' || status === 'completed') return 'ok'
  if (status === 'failed') return 'error'
  return 'pending'
}

/** 失败传播（PRD 5.2）：工具失败 → Step 红；Step 红 → Turn 红。 */
export function effectiveStepTone(step: StepRecord): DagStatusTone {
  const own = statusTone(step.status)
  if (own === 'error') return 'error'
  return step.toolCalls.some((tool) => statusTone(tool.status) === 'error') ? 'error' : own
}

/** 失败传播（PRD 5.2）：任一 Step 红 → Turn 红。 */
export function effectiveTurnTone(turn: TurnRecord): DagStatusTone {
  const own = statusTone(turn.status)
  if (own === 'error') return 'error'
  return turn.steps.some((step) => effectiveStepTone(step) === 'error') ? 'error' : own
}

/** Step 节点展开时展示的工具 chip（label + 色调）。 */
export interface DagToolChip {
  readonly label: string
  readonly tone: DagStatusTone
}

export interface DagNode {
  readonly id: string
  readonly kind: DagNodeKind
  readonly label: string
  readonly status: DagStatusTone
  /** turn: 用户输入；step: **人话动作**（由工具调用派生）；tool: 工具动作 + 宾语。 */
  readonly detail: string
  /**
   * step 节点专属（只增字段）：模型思考的首句摘要。
   *
   * 过去节点副标题直接截断 `step.llmReasoning`——那是模型自己的话，现在还混着思考正文，
   * 于是「节点上写的到底是什么」没人说得清。现在动作与思考分开：副标题是动作，
   * 思考单独一行（展开态显示）。
   */
  readonly thought?: string | undefined
  /** tool 节点专属：与图谱节点 id 对齐，供联动使用。 */
  readonly pluginId?: string | undefined
  readonly durationMs?: number | undefined
  /** step 节点专属：展开时渲染的工具 chips。 */
  readonly tools?: readonly DagToolChip[] | undefined
}

export type DagEdgeKind = 'turn-step' | 'step-tool' | 'step-step'

export interface DagEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly kind: DagEdgeKind
}

export interface DagGraph {
  readonly nodes: DagNode[]
  readonly edges: DagEdge[]
  /** 结构签名（节点 id + 边 id，不含状态）：未变化时布局可跳过重排。 */
  readonly structuralKey: string
  /** 内容签名（结构 + 状态/文案/耗时）：用于触发渲染更新。 */
  readonly contentKey: string
}

function truncate(text: string, max = 42): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** turn → step → tool 建图；step 间用顺序边串起时间线走向。 */
export function buildDagFromTurns(turns: readonly TurnRecord[]): DagGraph {
  const nodes: DagNode[] = []
  const edges: DagEdge[] = []

  for (const [turnIndex, turn] of turns.entries()) {
    nodes.push({
      id: turn.id,
      kind: 'turn',
      // 显示人话序号而不是 `${sessionId}:t1` 这种原始 id（时间线同样处理）。
      label: `第 ${turnOrdinal(turn.id, turnIndex)} 轮`,
      status: effectiveTurnTone(turn),
      detail: truncate(turn.userMessage, 48),
    })

    let previousStepId: string | null = null
    for (const step of turn.steps) {
      const thought = step.reasoning === undefined ? '' : summarizeThinking(step.reasoning, 60)
      nodes.push({
        id: step.id,
        kind: 'step',
        label: `Step ${step.index + 1}`,
        status: effectiveStepTone(step),
        detail: describeStepAction(step, 44).text,
        ...(thought === '' ? {} : { thought }),
        tools: step.toolCalls.map((tool) => ({
          label: tool.toolName,
          tone: statusTone(tool.status),
        })),
      })
      edges.push({
        id: `${turn.id}->${step.id}`,
        source: turn.id,
        target: step.id,
        kind: 'turn-step',
      })
      if (previousStepId !== null) {
        edges.push({
          id: `${previousStepId}->${step.id}`,
          source: previousStepId,
          target: step.id,
          kind: 'step-step',
        })
      }
      previousStepId = step.id

      for (const toolCall of step.toolCalls) {
        nodes.push({
          id: toolCall.id,
          kind: 'tool',
          label: toolCall.toolName,
          status: statusTone(toolCall.status),
          detail: describeToolCall(toolCall, 32),
          pluginId: toolCall.pluginId,
          ...(toolCall.durationMs === undefined ? {} : { durationMs: toolCall.durationMs }),
        })
        edges.push({
          id: `${step.id}->${toolCall.id}`,
          source: step.id,
          target: toolCall.id,
          kind: 'step-tool',
        })
      }
    }
  }

  const structuralKey = `${nodes.map((node) => node.id).join(',')}|${edges
    .map((edge) => edge.id)
    .join(',')}`
  const statusKey = nodes
    .map(
      (node) =>
        `${node.status}:${node.detail}:${node.thought ?? ''}:${String(node.durationMs ?? '')}`,
    )
    .join(',')

  return { nodes, edges, structuralKey, contentKey: `${structuralKey}|${statusKey}` }
}
