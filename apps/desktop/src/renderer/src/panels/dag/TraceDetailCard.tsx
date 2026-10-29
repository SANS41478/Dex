import {
  CopyableText,
  DetailPanel,
  DetailRows,
  DetailSection,
} from '../../components/detail/DetailPanel'
import {
  type DagStatusTone,
  effectiveStepTone,
  effectiveTurnTone,
  statusTone,
} from '../../core/dag-graph'
import type { TraceSelection } from '../../core/linkage'
import { describeStepAction, describeToolCall, summarizeMessage } from '../../core/step-summary'
import { formatClock, formatDuration, statusLabel, toneClass } from '../../core/timeline'
import type { ApprovalRecord, PolicyChange, StepRecord, ToolCallRecord } from '../../core/trace'

export interface TraceDetailCardProps {
  readonly selection: TraceSelection
  readonly policyChanges: readonly PolicyChange[]
  readonly approvals: readonly ApprovalRecord[]
  /** 点插件 → 图谱正式选中并聚焦（由 GraphPanel 消费 focusRequest）。 */
  readonly onSelectPlugin: (pluginId: string) => void
  /** 点某一步 → 选中该 Step（详情卡跟着切换）。 */
  readonly onSelectStep: (stepId: string) => void
  readonly onClose: () => void
}

const KIND_LABELS = { turn: '轮次', step: '步骤', tool: '工具调用' } as const

function durationText(record: {
  readonly startedAt: number
  readonly endedAt?: number | undefined
  readonly durationMs?: number | undefined
}): string {
  if (record.durationMs !== undefined) return formatDuration(record.durationMs)
  if (record.endedAt === undefined) return '进行中'
  return formatDuration(record.endedAt - record.startedAt)
}

/**
 * 执行流 / 时间线的详情面板。
 *
 * 摘要态（首次点击）只回答三件事：**这是什么、做了什么、现在什么状态**；
 * 思考全文、工具入参出参、失败原因、策略审计都收在详情态里——它们很长，
 * 不该在点一下的瞬间就糊满屏幕。
 */
export function TraceDetailCard({
  selection,
  policyChanges,
  approvals,
  onSelectPlugin,
  onSelectStep,
  onClose,
}: TraceDetailCardProps) {
  const { turn, step, tool } = selection
  const tone: DagStatusTone =
    selection.kind === 'tool'
      ? statusTone(tool?.status ?? '')
      : selection.kind === 'step'
        ? step === undefined
          ? 'pending'
          : effectiveStepTone(step)
        : effectiveTurnTone(turn)
  const record = selection.kind === 'tool' ? tool : selection.kind === 'step' ? step : turn
  const pluginIds = [...new Set(pluginsInSelection(selection))]

  const summary =
    selection.kind === 'turn' ? (
      <>
        <p className="detail-summary-line">提问：{summarizeMessage(turn.userMessage, 96)}</p>
        <p className="detail-summary-meta mono">
          {statusLabel(tone)} · {durationText(turn)} · {turn.steps.length} 步 ·{' '}
          {countTools(turn.steps)} 次工具调用
        </p>
      </>
    ) : selection.kind === 'step' && step !== undefined ? (
      <>
        <p className="detail-summary-line">{describeStepAction(step, 96).text}</p>
        <p className="detail-summary-meta mono">
          Step {step.index + 1} · {statusLabel(tone)} · {durationText(step)} ·{' '}
          {step.toolCalls.length} 次工具调用
        </p>
      </>
    ) : tool !== undefined ? (
      <>
        <p className="detail-summary-line">{describeToolCall(tool, 96)}</p>
        <p className="detail-summary-meta mono">
          {tool.toolName} · {statusLabel(tone)} · {durationText(tool)}
        </p>
      </>
    ) : null

  return (
    <DetailPanel
      testId="trace-detail"
      title={
        <>
          <span className="detail-kind">{KIND_LABELS[selection.kind]}</span>
          <span className="mono">{selection.kind === 'turn' ? turn.id : (record?.id ?? '')}</span>
        </>
      }
      summary={
        <>
          {summary}
          {pluginIds.length > 0 ? (
            <p className="detail-summary-links">
              <span className="muted">相关插件</span>
              {pluginIds.slice(0, 3).map((pluginId) => (
                <PluginLink key={pluginId} pluginId={pluginId} onSelectPlugin={onSelectPlugin} />
              ))}
            </p>
          ) : null}
        </>
      }
      onClose={onClose}
    >
      <DetailSection title="概览">
        <DetailRows
          rows={[
            {
              label: '状态',
              value: <span className={`trace-tone-${toneClass(tone)}`}>{statusLabel(tone)}</span>,
            },
            {
              label: '时间',
              value:
                record === undefined
                  ? '—'
                  : `${formatClock(record.startedAt)}${record.endedAt === undefined ? ' → …' : ` → ${formatClock(record.endedAt)}`}`,
              mono: true,
            },
            { label: '耗时', value: record === undefined ? '—' : durationText(record), mono: true },
            { label: '记录 id', value: record?.id ?? '—', mono: true },
          ]}
        />
      </DetailSection>

      {selection.kind === 'turn' ? (
        <>
          <DetailSection title="提问">
            <p className="trace-text">{turn.userMessage || '（等待提问）'}</p>
          </DetailSection>
          {turn.assistantMessage !== undefined ? (
            <DetailSection title="最终回复">
              <CopyableText text={turn.assistantMessage} />
            </DetailSection>
          ) : null}
          {turn.failureMessage !== undefined ? (
            <DetailSection title="失败原因">
              <p className="trace-failure" role="alert">
                {turn.failureCode !== undefined ? `${turn.failureCode}：` : ''}
                {turn.failureMessage}
              </p>
            </DetailSection>
          ) : null}
          <DetailSection title={`这一步之后的步骤（${turn.steps.length}）`}>
            {turn.steps.length === 0 ? (
              <p className="muted">这一轮还没有产生步骤。</p>
            ) : (
              <ul className="trace-step-list">
                {turn.steps.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="graph-edge-link"
                      onClick={() => {
                        onSelectStep(item.id)
                      }}
                    >
                      <span className={`dot dot-${toneClass(effectiveStepTone(item))}`} />
                      <span className="mono">Step {item.index + 1}</span>
                      <span className="muted">{describeStepAction(item, 48).text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
        </>
      ) : null}

      {selection.kind === 'step' && step !== undefined ? (
        <>
          <DetailSection title="模型思考">
            {step.reasoning === undefined || step.reasoning.trim() === '' ? (
              <p className="muted">这一步没有留下思考记录。</p>
            ) : (
              <CopyableText text={step.reasoning} testId="trace-thinking" />
            )}
          </DetailSection>
          <DetailSection title="模型输出">
            <p className="trace-text">{step.llmReasoning || '（这一步没有可见输出）'}</p>
          </DetailSection>
          <StepTools step={step} onSelectPlugin={onSelectPlugin} />
        </>
      ) : null}

      {selection.kind === 'tool' && tool !== undefined ? (
        <>
          <DetailSection title="工具">
            <DetailRows
              rows={[
                { label: '动作', value: describeToolCall(tool, 80) },
                { label: '工具名', value: tool.toolName, mono: true },
                { label: '所属步骤', value: tool.stepId, mono: true },
              ]}
            />
            <PluginLink pluginId={tool.pluginId} onSelectPlugin={onSelectPlugin} />
          </DetailSection>
          <DetailSection title="输入">
            <CopyableText text={JSON.stringify(tool.input, null, 2)} testId="trace-input" />
          </DetailSection>
          <DetailSection title="输出">
            {tool.output === undefined || tool.output === null ? (
              <p className="muted">（无输出）</p>
            ) : (
              <CopyableText text={toolOutputText(tool)} testId="trace-output" />
            )}
          </DetailSection>
        </>
      ) : null}

      <PolicyAuditBlock policyChanges={policyChanges} approvals={approvals} />
    </DetailPanel>
  )
}

function StepTools({
  step,
  onSelectPlugin,
}: {
  readonly step: StepRecord
  readonly onSelectPlugin: (pluginId: string) => void
}) {
  const calls = step.toolCalls
  return (
    <DetailSection title={`工具调用（${calls.length}）`}>
      {calls.length === 0 ? (
        <p className="muted">这一步没有调用工具。</p>
      ) : (
        <ul className="trace-tool-list">
          {calls.map((call) => (
            <li key={call.id}>
              <span className={`dot dot-${toneClass(statusTone(call.status))}`} />
              <span>{describeToolCall(call, 60)}</span>
              <span className="mono muted">{durationText(call)}</span>
              <PluginLink pluginId={call.pluginId} onSelectPlugin={onSelectPlugin} />
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  )
}

function PolicyAuditBlock({
  policyChanges,
  approvals,
}: {
  readonly policyChanges: readonly PolicyChange[]
  readonly approvals: readonly ApprovalRecord[]
}) {
  const recentPolicies = policyChanges.slice(-6)
  const recentApprovals = approvals.slice(-6)
  if (recentPolicies.length === 0 && recentApprovals.length === 0) return null

  return (
    <DetailSection title="权限与策略">
      <div data-testid="policy-audit">
        {recentPolicies.length === 0 ? (
          <p className="muted">暂无策略变更</p>
        ) : (
          <ul className="trace-audit-list">
            {recentPolicies.map((change) => (
              <li key={change.changeId}>
                <span className="mono">{policyLabel(change.kind)}</span>
                <span className="mono">{change.value}</span>
                <span className="muted">{formatClock(change.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {recentApprovals.length > 0 ? (
          <ul className="trace-audit-list">
            {recentApprovals.map((approval) => (
              <li key={`${approval.requestId}:${approval.phase}`}>
                <span
                  className={`dot dot-${approval.phase === 'asked' ? 'running' : approval.outcome === 'allowed-once' ? 'success' : 'failed'}`}
                />
                <span className="mono">{approval.toolName}</span>
                <span>
                  {approval.phase === 'asked' ? '请求' : approvalOutcomeLabel(approval.outcome)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </DetailSection>
  )
}

function policyLabel(kind: PolicyChange['kind']): string {
  if (kind === 'preset') return '预设'
  if (kind === 'sandbox') return '沙箱'
  return '审批'
}

function approvalOutcomeLabel(outcome: ApprovalRecord['outcome']): string {
  if (outcome === 'allowed-once') return '已允许一次'
  if (outcome === 'rejected') return '已拒绝'
  if (outcome === 'cancelled') return '已取消'
  if (outcome === 'unavailable') return '不可用'
  return '已决定'
}

function PluginLink({
  pluginId,
  onSelectPlugin,
}: {
  readonly pluginId: string
  readonly onSelectPlugin: (pluginId: string) => void
}) {
  if (pluginId === 'unknown') return <span className="muted mono">unknown</span>
  return (
    <button
      type="button"
      className="graph-edge-link trace-plugin-link"
      onClick={() => {
        onSelectPlugin(pluginId)
      }}
      title="在 3D 图谱中选中该插件"
    >
      插件 {pluginId}
    </button>
  )
}

function countTools(steps: readonly StepRecord[]): number {
  return steps.reduce((count, step) => count + step.toolCalls.length, 0)
}

function pluginsInSelection(selection: TraceSelection): string[] {
  const ids: string[] = []
  const push = (tool: ToolCallRecord): void => {
    if (tool.pluginId !== 'unknown') ids.push(tool.pluginId)
  }
  if (selection.kind === 'tool') {
    if (selection.tool !== undefined) push(selection.tool)
  } else if (selection.kind === 'step') {
    for (const call of selection.step?.toolCalls ?? []) push(call)
  } else {
    for (const step of selection.turn.steps) {
      for (const call of step.toolCalls) push(call)
    }
  }
  return ids
}

function toolOutputText(tool: ToolCallRecord): string {
  if (tool.output === undefined || tool.output === null) return '（无输出）'
  if (typeof tool.output === 'string') return tool.output
  try {
    return JSON.stringify(tool.output, null, 2)
  } catch {
    return String(tool.output)
  }
}
