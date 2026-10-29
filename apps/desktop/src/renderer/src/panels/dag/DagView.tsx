import {
  Background,
  Controls,
  ReactFlow,
  type ReactFlowInstance,
  type Edge as RFEdge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveToken } from '../../core/color'
import { buildDagFromTurns, type DagEdge } from '../../core/dag-graph'
import { layoutDag, type PositionedDagNode, sizeOf } from '../../core/dag-layout'
import { filterTurnsByPlugin } from '../../core/linkage'
import { useElementSize } from '../../hooks/useElementSize'
import { useLinkageStore } from '../../stores/linkageStore'
import { useTraceSelectionStore } from '../../stores/traceSelectionStore'
import { useTraceStore } from '../../stores/traceStore'
import { DagNodeCard } from './nodes/DagNodeCard'
import type { DexDagNode } from './types'

const nodeTypes = { 'dex-dag': DagNodeCard }

export function DagView() {
  const turns = useTraceStore((state) => state.turns)
  const selectedId = useTraceSelectionStore((state) => state.selectedId)
  const select = useTraceSelectionStore((state) => state.select)
  const toggle = useTraceSelectionStore((state) => state.toggle)
  const pluginFilterId = useLinkageStore((state) => state.pluginFilterId)
  const { ref, size } = useElementSize<HTMLDivElement>()

  const [placed, setPlaced] = useState<PositionedDagNode[]>([])
  const [edges, setEdges] = useState<DagEdge[]>([])
  const positionsRef = useRef(new Map<string, { x: number; y: number }>())
  const structuralKeyRef = useRef('')
  const layoutSeqRef = useRef(0)
  const lastCenteredRef = useRef<string | null>(null)
  const flowRef = useRef<ReactFlowInstance<DexDagNode, RFEdge> | null>(null)

  // L1 过滤：只看调用指定插件的 Step（M2-05）。
  const visibleTurns = useMemo(
    () => filterTurnsByPlugin(turns, pluginFilterId),
    [turns, pluginFilterId],
  )
  const graph = useMemo(() => buildDagFromTurns(visibleTurns), [visibleTurns])
  // 展开态 = 当前选中的 step 节点（点击展开、再次点击取消选中即收起）。
  const expandedId = useMemo(
    () =>
      selectedId !== null &&
      graph.nodes.some((node) => node.id === selectedId && node.kind === 'step')
        ? selectedId
        : null,
    [graph, selectedId],
  )

  const fitAfterLayout = useCallback(() => {
    window.requestAnimationFrame(() => {
      void flowRef.current?.fitView({ duration: 300, padding: 0.15 })
    })
  }, [])

  useEffect(() => {
    if (graph.nodes.length === 0) {
      structuralKeyRef.current = ''
      positionsRef.current = new Map()
      setPlaced([])
      setEdges([])
      return
    }

    const layoutKey = `${graph.structuralKey}|expanded:${expandedId ?? ''}`
    if (layoutKey === structuralKeyRef.current) {
      // 结构未变：沿用旧坐标，仅刷新内容（状态/文案/耗时/chips）。
      setPlaced(
        graph.nodes.map((node) => {
          const position = positionsRef.current.get(node.id) ?? { x: 0, y: 0 }
          return {
            ...node,
            ...sizeOf(node.kind, {
              expanded: node.id === expandedId,
              toolCount: node.tools?.length ?? 0,
              hasThought: node.thought !== undefined,
            }),
            x: position.x,
            y: position.y,
          }
        }),
      )
      setEdges(graph.edges)
      return
    }

    structuralKeyRef.current = layoutKey
    // 结构/展开变化立即布局（ELK 对小图毫秒级）；并发时用序号丢弃过期结果。
    // 注意：不要用重置式防抖窗口——演示流事件间隔小于窗口时会永远等不到布局。
    layoutSeqRef.current += 1
    const seq = layoutSeqRef.current
    void layoutDag(graph, { expandedId }).then((result) => {
      if (seq !== layoutSeqRef.current) return
      positionsRef.current = new Map(
        result.nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
      )
      setPlaced(result.nodes)
      setEdges(result.edges)
      fitAfterLayout()
    })
  }, [graph, expandedId, fitAfterLayout])

  const rfNodes: DexDagNode[] = useMemo(
    () =>
      placed.map((node) => ({
        id: node.id,
        type: 'dex-dag',
        position: { x: node.x, y: node.y },
        draggable: false,
        style: { width: node.width, height: node.height },
        data: {
          kind: node.kind,
          label: node.label,
          detail: node.detail,
          status: node.status,
          durationMs: node.durationMs,
          expanded: node.id === expandedId,
          tools: node.tools ?? [],
          thought: node.thought,
        },
      })),
    [placed, expandedId],
  )

  // 选中来自时间线时把对应节点移到视野中心；同一选中只居中一次，避免流式更新反复抢镜头。
  useEffect(() => {
    if (selectedId === null || lastCenteredRef.current === selectedId) return
    const node = placed.find((item) => item.id === selectedId)
    const instance = flowRef.current
    if (node === undefined || instance === null) return
    lastCenteredRef.current = selectedId
    void instance.setCenter(node.x + node.width / 2, node.y + node.height / 2, {
      // 从时间线点选过来时保证节点可读；已放大则保持用户当前缩放。
      zoom: Math.max(instance.getZoom(), 0.7),
      duration: 250,
    })
  }, [selectedId, placed])

  const rfEdges: RFEdge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
      })),
    [edges],
  )

  return (
    <div ref={ref} className="relative min-w-0 flex-1 overflow-hidden" data-testid="dag-stage">
      {size.width > 0 && size.height > 0 ? (
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          nodesDraggable={false}
          fitView
          minZoom={0.15}
          onInit={(instance) => {
            flowRef.current = instance
          }}
          onNodeClick={(_event, node) => {
            toggle(node.id)
          }}
          onPaneClick={() => {
            select(null)
          }}
          style={{ width: size.width, height: size.height }}
        >
          <Background color={resolveToken('--color-border-subtle')} gap={22} size={1.4} />
          <Controls showInteractive={false} />
        </ReactFlow>
      ) : null}
      {placed.length === 0 ? (
        <p className="placeholder dag-empty">
          {pluginFilterId === null ? '等待事件流…' : '该插件没有可展示的 Step'}
        </p>
      ) : null}
    </div>
  )
}
