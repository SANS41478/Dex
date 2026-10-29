import type { GraphNode } from '@dexagent/shared'
import { DetailPanel, DetailRows, DetailSection } from '../../components/detail/DetailPanel'
import type { EdgeSummary } from '../../core/graph-interaction'
import { describePluginNode } from '../../core/plugin-capability'
import { STATUS_LABELS, TYPE_LABELS } from './labels'

export interface NodeDetailCardProps {
  readonly node: GraphNode
  readonly degree: number
  readonly incoming: readonly EdgeSummary[]
  readonly outgoing: readonly EdgeSummary[]
  readonly focusOnly: boolean
  /** 本会话中该插件被调用的次数（图谱 → 执行流的连接点）。 */
  readonly usageCount: number
  readonly onToggleFocus: () => void
  readonly onSelect: (nodeId: string) => void
  /** 在执行流/时间线里只看调用该插件的 Step。 */
  readonly onFilterTrace: () => void
  readonly onClose: () => void
}

/**
 * 图谱节点详情：摘要态回答「这是什么、干什么用的」，详情态再给依赖、配置与调用记录。
 *
 * 摘要文案来自 `core/plugin-capability.ts`：dsh 的 loader 条目不带用途描述，
 * 所以已知包走静态能力表，未知包老实说「这是工具插件」，不编用途。
 */
export function NodeDetailCard({
  node,
  degree,
  incoming,
  outgoing,
  focusOnly,
  usageCount,
  onToggleFocus,
  onSelect,
  onFilterTrace,
  onClose,
}: NodeDetailCardProps) {
  const brief = describePluginNode(node, { incoming: incoming.length, outgoing: outgoing.length })

  return (
    <DetailPanel
      testId="graph-node-detail"
      title={
        <>
          <span className="detail-kind">{TYPE_LABELS[node.type]}</span>
          <span className="mono">{node.label}</span>
        </>
      }
      summary={
        <>
          <p className="detail-summary-line">{brief.role}</p>
          <p className="detail-summary-line muted" data-testid="graph-node-capability">
            {brief.capability ?? node.moduleName ?? '内建条目（Loader 未提供模块名）'}
          </p>
          <p className="detail-summary-meta mono">
            {STATUS_LABELS[node.status]} · 连接度 {degree} · 本会话调用 {usageCount} 次
          </p>
        </>
      }
      summaryActions={
        <button
          type="button"
          className={`graph-chip${focusOnly ? ' graph-chip-active' : ''}`}
          onClick={onToggleFocus}
          data-testid="graph-focus-toggle"
        >
          {focusOnly ? '显示全部节点' : '只看邻居（聚焦子图）'}
        </button>
      }
      detailActions={
        <button
          type="button"
          className="graph-chip"
          onClick={onFilterTrace}
          data-testid="graph-usage-filter"
          title="在执行流与时间线中只看调用该插件的 Step"
        >
          查看调用记录（{usageCount}）
        </button>
      }
      onClose={onClose}
    >
      <DetailSection title="概览">
        <DetailRows
          rows={[
            { label: '类型', value: `${TYPE_LABELS[node.type]} · ${STATUS_LABELS[node.status]}` },
            { label: '条目 id', value: node.id, mono: true },
            { label: '模块', value: node.moduleName ?? '内建条目', mono: true },
            {
              label: '连接度',
              value: `${degree}（依赖 ${incoming.length} / 被依赖 ${outgoing.length}）`,
            },
          ]}
        />
      </DetailSection>

      <DetailSection title="能力预览">
        <DetailRows
          rows={[
            { label: '配置状态', value: node.disabled === true ? '已禁用' : '未禁用' },
            {
              label: '配置键',
              value:
                node.configReadable === true
                  ? node.configKeys?.length
                    ? node.configKeys.join(', ')
                    : '无公开配置键'
                  : '配置不可读取',
              mono: true,
            },
            { label: '运行时修改', value: '当前版本不支持' },
          ]}
        />
      </DetailSection>

      <DetailSection title="本会话调用">
        {usageCount === 0 ? (
          <p className="muted">这一轮会话里还没有调用过它。</p>
        ) : (
          <p>
            共 <span className="mono">{usageCount}</span> 次工具调用使用了这个插件。
          </p>
        )}
      </DetailSection>

      <DetailSection title={`依赖（入 ${incoming.length}）`}>
        <EdgeList edges={incoming} onSelect={onSelect} empty="没有依赖其它插件" />
      </DetailSection>

      <DetailSection title={`被依赖（出 ${outgoing.length}）`}>
        <EdgeList edges={outgoing} onSelect={onSelect} empty="没有其它插件依赖它" />
      </DetailSection>
    </DetailPanel>
  )
}

function EdgeList({
  edges,
  onSelect,
  empty,
}: {
  readonly edges: readonly EdgeSummary[]
  readonly onSelect: (nodeId: string) => void
  readonly empty: string
}) {
  if (edges.length === 0) return <p className="muted">{empty}</p>
  return (
    <ul className="graph-detail-edges">
      {edges.map((edge) => (
        <li key={edge.linkId}>
          <button type="button" className="graph-edge-link" onClick={() => onSelect(edge.nodeId)}>
            {edge.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
