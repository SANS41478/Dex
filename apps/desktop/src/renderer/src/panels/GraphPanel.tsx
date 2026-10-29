import type { GraphLink, GraphNode, PluginType } from '@dexagent/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraphMethods } from 'react-force-graph-3d'
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  PointLight,
  SRGBColorSpace,
} from 'three'
import { resetColorCache, resolveToken } from '../core/color'
import {
  applyGraphUpdate,
  createGraphData,
  type GraphData,
  type GraphNodeData,
  pinSettledNodes,
  releasePins,
} from '../core/graph-data'
import {
  type CameraView,
  computeDegrees,
  countTypes,
  edgeSummaries,
  filterGraph,
  linkEnds,
  matchesQuery,
  neighborsOf,
  parseCameraView,
  serializeCameraView,
  subgraphOf,
} from '../core/graph-interaction'
import { type GraphLabelCandidate, layoutGraphLabels } from '../core/graph-label-layout'
import {
  createGraphSnapshot,
  describeSnapshotSaveResult,
  serializeGraphSnapshotJson,
} from '../core/graph-snapshot'
import { findTraceSelection, pluginsOfSelection } from '../core/linkage'
import { createNodeMeshPool, type NodeVisualSample } from '../core/node-shapes'
import { countPluginUsage } from '../core/plugin-capability'
import { useElementSize } from '../hooks/useElementSize'
import { useTheme } from '../hooks/useTheme'
import { useGraphStore } from '../stores/graphStore'
import { useLinkageStore } from '../stores/linkageStore'
import { useTraceSelectionStore } from '../stores/traceSelectionStore'
import { useTraceStore } from '../stores/traceStore'
import { GraphControls } from './graph/GraphControls'
import { GraphLabels, type GraphLabelView } from './graph/GraphLabels'
import { GraphLegend } from './graph/GraphLegend'
import { TYPE_ORDER } from './graph/labels'
import { NodeDetailCard } from './graph/NodeDetailCard'

declare global {
  interface Window {
    /** DEV 诊断（布局稳定性/相机持久化/渲染数据校验）：只读探针 + 按 id 聚焦。 */
    __dexGraphDebug?: {
      positions: () => {
        id: string
        x?: number | undefined
        y?: number | undefined
        z?: number | undefined
        pinned: boolean
      }[]
      getCamera: () => CameraView | null
      focusNode: (nodeId: string) => void
      /** 可见（渲染中）的节点/边数量。 */
      render: () => { nodes: number; links: number }
      /** 数据层 link 端点（不可变 id 与库 scratch 字段的运行时形态）。 */
      links: () => {
        id: string
        sourceKind: string
        targetKind: string
        sourceId: string | null
        targetId: string | null
      }[]
      /** 当前被 pin（fx/fy/fz 已固定）的节点数。 */
      pinnedCount: () => number
      /** 拖拽事件计数（验证拖拽命中与解 pin 是否发生）。 */
      dragCount: () => number
      /** 节点屏幕坐标（拖拽复现用；相对 canvas 左上角）。 */
      screenOf: (nodeId: string) => { x: number; y: number } | null
      /** 当前联动高亮的插件节点 id（来自执行流选中，M2-05）。 */
      linked: () => string[]
      /** 图谱当前选中的节点 id。 */
      selected: () => string | null
      /** 全部节点摘要（联动脚本选目标用）。 */
      nodes: () => { id: string; type: string; label: string; status: string }[]
      visual: (nodeId: string) => NodeVisualSample | null
      labelCount: () => number
      lightCount: () => number
    }
  }
}

/** 引擎收敛后的最大 tick 数：限制首轮布局耗时，之后由 pin 固定。 */
const COOLDOWN_TICKS = 180
const CAMERA_STORAGE_KEY = 'dex.graph.camera.v1'
const MOTION_STORAGE_KEY = 'dex.graph.motion.v1'
const FOCUS_DISTANCE = 90
const PARTICLE_NODE_LIMIT = 250
const ALWAYS_LABEL_LIMIT = 10

function readMotionEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(MOTION_STORAGE_KEY) !== '0'
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const ALL_TYPES: ReadonlySet<PluginType> = new Set(TYPE_ORDER)
const exportStamp = (): string => {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function saveSnapshotFile(payload: {
  suggestedName: string
  mime: 'application/json' | 'image/png'
  data: string
}): Promise<unknown> {
  if (window.dex?.snapshot !== undefined) {
    return await window.dex.snapshot.save(payload)
  }
  const link = document.createElement('a')
  link.href =
    payload.mime === 'image/png'
      ? payload.data
      : `data:application/json;charset=utf-8,${encodeURIComponent(payload.data)}`
  link.download = payload.suggestedName
  link.click()
  return { canceled: false }
}

interface GraphControlsLike {
  target: { x: number; y: number; z: number }
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

interface GraphCameraLike {
  position: { x: number; y: number; z: number }
}

export function GraphPanel() {
  const nodes = useGraphStore((state) => state.nodes)
  const links = useGraphStore((state) => state.links)
  const turns = useTraceStore((state) => state.turns)
  const traceSelectedId = useTraceSelectionStore((state) => state.selectedId)
  const setPluginFilter = useLinkageStore((state) => state.setPluginFilter)
  const focusRequest = useLinkageStore((state) => state.focusRequest)
  const clearFocusRequest = useLinkageStore((state) => state.clearFocusRequest)
  const { ref, size } = useElementSize<HTMLDivElement>()
  const { resolved: theme } = useTheme()

  const graphRef = useRef<ForceGraphMethods | undefined>(undefined)
  const dataRef = useRef<GraphData>(createGraphData())
  const poolRef = useRef(createNodeMeshPool())
  const cameraRestoredRef = useRef(false)
  const cameraCleanupRef = useRef<(() => void) | null>(null)
  const draggingRef = useRef(false)
  const linkedRef = useRef<ReadonlySet<string>>(new Set())
  const selectedRef = useRef<string | null>(null)
  const lightsConfiguredRef = useRef(false)
  const themeRef = useRef(theme)
  const updateLabelsRef = useRef<() => void>(() => undefined)
  const [, setThemeRevision] = useState(0)
  const [motionEnabled, setMotionEnabled] = useState(readMotionEnabled)
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)
  const [labels, setLabels] = useState<readonly GraphLabelView[]>([])

  // 两个身份：
  // - `graphState` 传给渲染库，只在结构性变化（增删/端点变化）时更换 → 触发库重排；
  // - `snapshot` 供派生计算（度数/计数/可见性/详情）使用，任何数据变化都更新。
  const [graphState, setGraphState] = useState(() => ({
    nodes: dataRef.current.nodes,
    links: dataRef.current.links,
  }))
  const [snapshot, setSnapshot] = useState(() => ({
    nodes: dataRef.current.nodes as readonly GraphNode[],
    links: dataRef.current.links as readonly GraphLink[],
  }))
  const [stats, setStats] = useState({ nodes: 0, links: 0, visibleNodes: 0, visibleLinks: 0 })
  const [visibleTypes, setVisibleTypes] = useState<ReadonlySet<PluginType>>(ALL_TYPES)
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusOnly, setFocusOnly] = useState(false)
  const [forcedVisibleId, setForcedVisibleId] = useState<string | null>(null)
  const [exportFeedback, setExportFeedback] = useState<string | null>(null)

  // 执行流选中 → 联动高亮（弱强调；不触碰图谱自身选中、相机与详情卡）。
  const linkedIds = useMemo(
    () => new Set(pluginsOfSelection(findTraceSelection(traceSelectedId, turns))),
    [traceSelectedId, turns],
  )
  linkedRef.current = linkedIds
  selectedRef.current = selectedId

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (themeRef.current === theme) return
    themeRef.current = theme
    resetColorCache()
    poolRef.current.refreshTheme()
    setThemeRevision((value) => value + 1)
  }, [theme])

  useEffect(() => {
    const pool = poolRef.current
    if (!motionEnabled || reducedMotion) {
      pool.applyBreathing(0)
      return
    }
    let frame = 0
    const startedAt = performance.now()
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const tick = (now: number): void => {
      // Electron 下 `emulateMedia` / 系统偏好变化不一定派发 MediaQueryList change；
      // 每帧读取一次 matches，保证 reduced-motion 在下一帧就生效。
      if (motionQuery.matches) {
        pool.applyBreathing(0)
        setReducedMotion(true)
        return
      }
      pool.applyBreathing(now - startedAt)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [motionEnabled, reducedMotion])

  const toggleMotion = useCallback(() => {
    setMotionEnabled((current) => {
      const next = !current
      try {
        localStorage.setItem(MOTION_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // 隐私模式忽略
      }
      return next
    })
  }, [])

  // �� ���ݺϲ����ڵ���������ȶ��������꣩���ṹ�Ա仯���������ã����氲ȫ���� `graph-data.ts`����
  // �ṹ�仯���� `graphData` ���ݴ�����Ⱦ�����������ȣ������ֶ� `d3ReheatSimulation()`��
  useEffect(() => {
    const result = applyGraphUpdate(dataRef.current, { nodes, links })
    if (result.structural) {
      setGraphState({ nodes: dataRef.current.nodes, links: dataRef.current.links })
    }
    if (result.structural || result.content) {
      setSnapshot({ nodes: dataRef.current.nodes, links: dataRef.current.links })
    }
  }, [nodes, links])

  // ② 可见性（类型过滤 ∩ 聚焦子图）：只切换可见性，不重排、不丢坐标。
  useEffect(() => {
    const all = snapshot.nodes
    const allLinks = snapshot.links
    const typeFilterActive = visibleTypes.size !== TYPE_ORDER.length

    let ids: Set<string> | null = null
    if (typeFilterActive || focusOnly) {
      const base = filterGraph(all, allLinks, visibleTypes)
      ids =
        focusOnly && selectedId !== null
          ? new Set(subgraphOf(selectedId, base.nodes, base.links, 1))
          : new Set(base.nodes.map((node) => node.id))
    }
    if (forcedVisibleId !== null && all.some((node) => node.id === forcedVisibleId)) {
      if (ids === null) ids = new Set(all.map((node) => node.id))
      ids.add(forcedVisibleId)
    } else if (forcedVisibleId !== null) {
      setForcedVisibleId(null)
    }

    let visibleLinks = allLinks.length
    if (ids !== null) {
      let count = 0
      for (const link of allLinks) {
        const ends = linkEnds(link)
        if (ends !== null && ids.has(ends.sourceId) && ids.has(ends.targetId)) count += 1
      }
      visibleLinks = count
    }

    setVisibleIds(ids)
    setStats({
      nodes: all.length,
      links: allLinks.length,
      visibleNodes: ids === null ? all.length : ids.size,
      visibleLinks,
    })

    // 选中的节点被隐藏 → 自动清选并退出聚焦（否则详情卡消失、开关不可达）。
    if (ids !== null && selectedId !== null && !ids.has(selectedId)) {
      setSelectedId(null)
      setFocusOnly(false)
    }
  }, [snapshot, visibleTypes, focusOnly, selectedId, forcedVisibleId])

  const visibleFilter = useMemo(
    () => ({
      active: visibleIds !== null,
      ids: visibleIds,
    }),
    [visibleIds],
  )

  const degrees = useMemo(() => computeDegrees(snapshot.nodes, snapshot.links), [snapshot])
  const maxDegree = useMemo(() => Math.max(1, ...degrees.values()), [degrees])
  const typeCounts = useMemo(() => countTypes(snapshot.nodes), [snapshot])

  const selectedNode = useMemo(
    () => snapshot.nodes.find((node) => node.id === selectedId) ?? null,
    [snapshot, selectedId],
  )
  const detailEdges = useMemo(() => {
    if (selectedId === null) return { incoming: [], outgoing: [] }
    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]))
    return edgeSummaries(selectedId, snapshot.links, nodesById)
  }, [snapshot, selectedId])

  // 本会话调用次数：把「图谱里的插件」和「执行流里的调用」连起来（详情态可一键过滤）。
  const selectedUsage = useMemo(
    () => (selectedId === null ? 0 : countPluginUsage(turns, selectedId)),
    [turns, selectedId],
  )

  const labelNodes = useMemo(() => {
    const visible = snapshot.nodes.filter((node) => visibleIds === null || visibleIds.has(node.id))
    const ranked = [...visible].sort(
      (left, right) => (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0),
    )
    const result: GraphNode[] = []
    const seen = new Set<string>()
    const add = (node: GraphNode | undefined): void => {
      if (node === undefined || seen.has(node.id)) return
      seen.add(node.id)
      result.push(node)
    }
    add(ranked.find((node) => node.id === selectedId))
    add(ranked.find((node) => node.id === hoveredId))
    for (const node of ranked.slice(0, ALWAYS_LABEL_LIMIT)) add(node)
    return result
  }, [snapshot.nodes, visibleIds, degrees, selectedId, hoveredId])

  const updateLabels = useCallback(() => {
    const graph = graphRef.current
    if (!graph || size.width <= 0 || size.height <= 0) {
      setLabels([])
      return
    }
    const projected: GraphLabelCandidate[] = []
    for (const node of labelNodes) {
      const positioned = node as GraphNodeData
      if (positioned.x === undefined || positioned.y === undefined || positioned.z === undefined) {
        continue
      }
      const point = graph.graph2ScreenCoords(positioned.x, positioned.y, positioned.z)
      if (
        point.x < -80 ||
        point.y < -30 ||
        point.x > size.width + 80 ||
        point.y > size.height + 40
      ) {
        continue
      }
      projected.push({
        id: node.id,
        label: node.label,
        x: point.x,
        y: point.y - 10,
        force: node.id === selectedId || node.id === hoveredId,
      })
    }
    const placements = layoutGraphLabels(projected, size.width, size.height)
    const byId = new Map(labelNodes.map((node) => [node.id, node]))
    const next: GraphLabelView[] = []
    for (const placement of placements) {
      const node = byId.get(placement.id)
      if (node === undefined) continue
      next.push({
        id: node.id,
        label: node.label,
        type: node.type,
        status: node.status,
        x: placement.x,
        y: placement.y,
        selected: node.id === selectedId,
      })
    }
    setLabels(next)
  }, [hoveredId, labelNodes, selectedId, size.height, size.width])
  updateLabelsRef.current = updateLabels

  useEffect(() => {
    updateLabels()
  }, [updateLabels])

  // ③ 强调：只更新材质与缩放（数据/选中/悬停/联动变化时重算，不触碰库身份）。
  useEffect(() => {
    const pool = poolRef.current
    pool.prune(new Set(snapshot.nodes.map((node) => node.id)))
    pool.applyEmphasis({
      selectedId,
      hoveredId,
      neighbors: selectedId === null ? new Set<string>() : neighborsOf(selectedId, snapshot.links),
      linked: linkedIds,
    })
  }, [snapshot, selectedId, hoveredId, linkedIds])

  const nodeVisibility = useCallback(
    (node: object) =>
      !visibleFilter.active ||
      visibleFilter.ids === null ||
      visibleFilter.ids.has((node as GraphNode).id),
    [visibleFilter],
  )

  const linkVisibility = useCallback(
    (link: object) => {
      if (!visibleFilter.active || visibleFilter.ids === null) return true
      const ends = linkEnds(link as GraphLink)
      return (
        ends !== null &&
        visibleFilter.ids.has(ends.sourceId) &&
        visibleFilter.ids.has(ends.targetId)
      )
    },
    [visibleFilter],
  )

  const nodeThreeObject = useCallback(
    (node: object) => {
      const graphNode = node as GraphNode
      return poolRef.current.obtain(graphNode, degrees.get(graphNode.id) ?? 0, maxDegree)
    },
    [degrees, maxDegree],
  )

  const edgeColor = resolveToken('--color-border-default')
  const linkColor = useCallback(
    (link: object) => {
      if (selectedId !== null) {
        const ends = linkEnds(link as GraphLink)
        if (ends !== null && (ends.sourceId === selectedId || ends.targetId === selectedId)) {
          return resolveToken('--color-accent-primary')
        }
      }
      return edgeColor
    },
    [edgeColor, selectedId],
  )

  const linkWidth = useCallback(
    (link: object) => {
      if (selectedId === null) return 0.9
      const ends = linkEnds(link as GraphLink)
      return ends !== null && (ends.sourceId === selectedId || ends.targetId === selectedId)
        ? 2.6
        : 0.8
    },
    [selectedId],
  )

  const linkParticles = useCallback(
    (link: object) => {
      if (!motionEnabled || reducedMotion || snapshot.nodes.length > PARTICLE_NODE_LIMIT) {
        return 0
      }
      return (link as GraphLink).type === 'inject' ? 1 : 0
    },
    [motionEnabled, reducedMotion, snapshot.nodes.length],
  )

  const persistCamera = useCallback(() => {
    const graph = graphRef.current
    if (!graph) return
    const camera = graph.camera() as unknown as GraphCameraLike
    const controls = graph.controls() as unknown as GraphControlsLike
    const view: CameraView = {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      lookAt: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    }
    try {
      localStorage.setItem(CAMERA_STORAGE_KEY, serializeCameraView(view))
    } catch {
      /* 忽略写入失败 */
    }
  }, [])

  const focusNode = useCallback(
    (node: GraphNode) => {
      const graph = graphRef.current
      const target = node as unknown as { x?: number; y?: number; z?: number }
      if (!graph || target.x === undefined || target.y === undefined || target.z === undefined)
        return
      const distance = 1 + FOCUS_DISTANCE / Math.max(1, Math.hypot(target.x, target.y, target.z))
      graph.cameraPosition(
        { x: target.x * distance, y: target.y * distance, z: target.z * distance },
        { x: target.x, y: target.y, z: target.z },
        800,
      )
      window.setTimeout(persistCamera, 900)
    },
    [persistCamera],
  )

  const configureLights = useCallback(() => {
    const graph = graphRef.current
    if (!graph || lightsConfiguredRef.current) return
    lightsConfiguredRef.current = true
    const ambient = new AmbientLight(0xffffff, 0.55)
    const key = new DirectionalLight(0xffffff, 1.35)
    key.position.set(140, 180, 220)
    const rim = new PointLight(0xffffff, 0.5, 0, 2)
    rim.position.set(-180, -120, 160)
    graph.lights([ambient, key, rim])
    const renderer = graph.renderer()
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.08
    renderer.outputColorSpace = SRGBColorSpace
  }, [])

  const handleEngineStop = useCallback(() => {
    pinSettledNodes(dataRef.current)
    configureLights()
    updateLabelsRef.current()

    if (cameraRestoredRef.current) return
    const graph = graphRef.current
    if (!graph) return
    cameraRestoredRef.current = true

    let cameraApplied = false
    try {
      const saved = parseCameraView(localStorage.getItem(CAMERA_STORAGE_KEY))
      if (saved !== null) {
        graph.cameraPosition(saved.position, saved.lookAt, 0)
        cameraApplied = true
      }
    } catch {
      /* 无存储权限时忽略 */
    }
    if (!cameraApplied) {
      const distance = Math.max(900, Math.min(1_400, size.height * 1.25))
      graph.cameraPosition({ x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 0)
    }
    window.requestAnimationFrame(() => updateLabelsRef.current())

    const controls = graph.controls() as unknown as GraphControlsLike
    if (controls.addEventListener === undefined) return
    let lastSave = 0
    const onChange = (): void => {
      const now = Date.now()
      if (now - lastSave < 800) return
      lastSave = now
      persistCamera()
    }
    const onLabelsChange = (): void => updateLabelsRef.current()
    controls.addEventListener('change', onChange)
    controls.addEventListener('change', onLabelsChange)
    cameraCleanupRef.current = () => {
      controls.removeEventListener?.('change', onChange)
      controls.removeEventListener?.('change', onLabelsChange)
    }
  }, [configureLights, persistCamera, size.height])

  // 拖拽期间临时解 pin：邻居与边受力跟随；松手后引擎冷却 → onEngineStop 重新 pin。
  const dragCountRef = useRef(0)
  const handleNodeDrag = useCallback(() => {
    dragCountRef.current += 1
    if (draggingRef.current) return
    draggingRef.current = true
    releasePins(dataRef.current)
  }, [])

  const handleNodeDragEnd = useCallback(() => {
    draggingRef.current = false
  }, [])

  useEffect(() => {
    return () => {
      cameraCleanupRef.current?.()
      poolRef.current.dispose()
    }
  }, [])

  // DEV 诊断钩子：布局稳定性 / 相机持久化 / 渲染数据校验脚本用。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__dexGraphDebug = {
      positions: () =>
        dataRef.current.nodes.map((node) => ({
          id: node.id,
          x: node.x,
          y: node.y,
          z: node.z,
          pinned: node.fx !== undefined,
        })),
      getCamera: () => {
        const graph = graphRef.current
        if (!graph) return null
        const camera = graph.camera() as unknown as GraphCameraLike
        const controls = graph.controls() as unknown as GraphControlsLike
        return {
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          lookAt: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        }
      },
      focusNode: (nodeId: string) => {
        const node = dataRef.current.nodes.find((item) => item.id === nodeId)
        if (node !== undefined) focusNode(node)
      },
      render: () => ({ nodes: stats.visibleNodes, links: stats.visibleLinks }),
      links: () =>
        dataRef.current.links.map((link) => {
          const raw = link as unknown as { source?: unknown; target?: unknown }
          const ends = linkEnds(link)
          return {
            id: link.id,
            sourceKind: typeof raw.source,
            targetKind: typeof raw.target,
            sourceId: ends?.sourceId ?? null,
            targetId: ends?.targetId ?? null,
          }
        }),
      pinnedCount: () => dataRef.current.nodes.filter((node) => node.fx !== undefined).length,
      dragCount: () => dragCountRef.current,
      linked: () => [...linkedRef.current],
      selected: () => selectedRef.current,
      nodes: () =>
        dataRef.current.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          label: node.label,
          status: node.status,
        })),
      visual: (nodeId: string) => poolRef.current.sample(nodeId),
      labelCount: () => labels.length,
      lightCount: () => graphRef.current?.lights().length ?? 0,
      screenOf: (nodeId: string) => {
        const graph = graphRef.current
        const node = dataRef.current.nodes.find((item) => item.id === nodeId)
        if (!graph || node?.x === undefined || node.y === undefined || node.z === undefined) {
          return null
        }
        const point = graph.graph2ScreenCoords(node.x, node.y, node.z)
        return { x: point.x, y: point.y }
      },
    }
    return () => {
      delete window.__dexGraphDebug
    }
  }, [focusNode, labels.length, stats])

  /** 导航前仅临时放行目标节点，不修改用户的类型过滤或聚焦设置。 */
  const ensureVisible = useCallback((nodeId: string) => {
    const node = dataRef.current.nodes.find((item) => item.id === nodeId)
    if (node === undefined) return
    setForcedVisibleId(node.id)
  }, [])

  const handleSearch = useCallback(
    (query: string): boolean => {
      const match = dataRef.current.nodes.find((node) => matchesQuery(node, query))
      if (match === undefined) return false
      ensureVisible(match.id)
      setSelectedId(match.id)
      focusNode(match)
      return true
    },
    [ensureVisible, focusNode],
  )

  const handleSelect = useCallback(
    (nodeId: string) => {
      ensureVisible(nodeId)
      setSelectedId(nodeId)
      const node = dataRef.current.nodes.find((item) => item.id === nodeId)
      if (node !== undefined) focusNode(node)
    },
    [ensureVisible, focusNode],
  )

  const clearSelection = useCallback(() => {
    setSelectedId(null)
    setFocusOnly(false)
    setForcedVisibleId(null)
  }, [])

  // 详情卡里点插件 → 一次性聚焦请求（正式选中 + 相机飞过去）。
  useEffect(() => {
    if (focusRequest === null) return
    clearFocusRequest()
    const node = dataRef.current.nodes.find((item) => item.id === focusRequest.nodeId)
    if (node === undefined) return
    ensureVisible(node.id)
    setSelectedId(node.id)
    focusNode(node)
  }, [focusRequest, clearFocusRequest, ensureVisible, focusNode])

  const resetFilters = useCallback(() => {
    setVisibleTypes(ALL_TYPES)
    setFocusOnly(false)
    setForcedVisibleId(null)
  }, [])

  const toggleType = useCallback((type: PluginType) => {
    setForcedVisibleId(null)
    setVisibleTypes((current) => {
      const next = new Set(current)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  const cameraView = useCallback((): CameraView | null => {
    const graph = graphRef.current
    if (!graph) return null
    const camera = graph.camera() as unknown as GraphCameraLike
    const controls = graph.controls() as unknown as GraphControlsLike
    return {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      lookAt: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    }
  }, [])

  const exportJson = useCallback(() => {
    setExportFeedback(null)
    try {
      const timestamp = Date.now()
      const snapshot = createGraphSnapshot(
        dataRef.current.nodes,
        dataRef.current.links,
        {
          camera: cameraView(),
          visibleTypes: [...visibleTypes],
          focusOnly,
          selectedNodeId: selectedId,
        },
        timestamp,
      )
      void saveSnapshotFile({
        suggestedName: `dex-graph-${exportStamp()}.json`,
        mime: 'application/json',
        data: serializeGraphSnapshotJson(snapshot),
      })
        .then((result) => setExportFeedback(describeSnapshotSaveResult(result)))
        .catch((error: unknown) => {
          setExportFeedback(error instanceof Error ? error.message : 'JSON 导出失败')
        })
    } catch (error) {
      // 快照构造是**同步**的（内部 `.parse()`）。不加这一层，schema 一旦不匹配就会变成
      // 未捕获异常：既没有落盘、也没有任何提示，用户只看到「点了没反应」（黑盒报告 D13）。
      setExportFeedback(error instanceof Error ? error.message : 'JSON 导出失败')
    }
  }, [cameraView, focusOnly, selectedId, visibleTypes])

  const exportPng = useCallback(() => {
    setExportFeedback(null)
    const canvas = ref.current?.querySelector('canvas')
    if (!canvas) {
      setExportFeedback('当前画布还未就绪')
      return
    }
    const data = canvas.toDataURL('image/png')
    void saveSnapshotFile({
      suggestedName: `dex-graph-${exportStamp()}.png`,
      mime: 'image/png',
      data,
    })
      .then((result) => setExportFeedback(describeSnapshotSaveResult(result)))
      .catch((error: unknown) => {
        setExportFeedback(error instanceof Error ? error.message : 'PNG 导出失败')
      })
  }, [ref])

  return (
    <section className="panel" data-testid="panel-graph">
      <header className="panel-header">
        <span>3D 架构图谱</span>
        <span className="muted">
          节点 {stats.nodes} · 边 {stats.links}
          {stats.visibleNodes < stats.nodes ? `（显示 ${stats.visibleNodes}）` : ''}
        </span>
      </header>
      <div
        ref={ref}
        className="graph-stage relative min-w-0 flex-1 overflow-hidden"
        data-testid="graph-stage"
      >
        {size.width > 0 && size.height > 0 ? (
          <ForceGraph3D
            ref={graphRef}
            width={size.width}
            height={size.height}
            graphData={graphState}
            nodeId="id"
            linkSource="sourceId"
            linkTarget="targetId"
            nodeLabel="label"
            nodeThreeObject={nodeThreeObject}
            nodeVisibility={nodeVisibility}
            linkVisibility={linkVisibility}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkOpacity={0.55}
            linkDirectionalParticles={linkParticles}
            linkDirectionalParticleSpeed={0.002}
            linkDirectionalParticleWidth={1.6}
            linkDirectionalParticleResolution={4}
            linkDirectionalParticleColor={() => resolveToken('--color-accent-primary')}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            warmupTicks={0}
            cooldownTicks={COOLDOWN_TICKS}
            onEngineTick={configureLights}
            onEngineStop={handleEngineStop}
            onNodeDrag={handleNodeDrag}
            onNodeDragEnd={handleNodeDragEnd}
            onNodeClick={(node: object) => {
              const graphNode = node as GraphNode
              setForcedVisibleId(null)
              setSelectedId(graphNode.id)
              // L1（M2-05）：点工具类插件 → 执行流过滤出调用它的 Step；其它类型不清除现有过滤。
              if (graphNode.type === 'tool') setPluginFilter(graphNode.id)
            }}
            onNodeHover={(node: object | null) => {
              setHoveredId(node === null ? null : (node as GraphNode).id)
            }}
            onBackgroundClick={() => {
              clearSelection()
              setPluginFilter(null)
            }}
          />
        ) : null}
        <GraphLabels labels={labels} />
        <GraphControls
          counts={typeCounts}
          visible={visibleTypes}
          onToggle={toggleType}
          onReset={resetFilters}
          onSearch={handleSearch}
          onExportJson={exportJson}
          onExportPng={exportPng}
          motionEnabled={motionEnabled}
          onToggleMotion={toggleMotion}
          exportFeedback={exportFeedback}
        />
        <GraphLegend motionEnabled={motionEnabled} reducedMotion={reducedMotion} />
        {selectedNode !== null ? (
          <NodeDetailCard
            node={selectedNode}
            degree={degrees.get(selectedNode.id) ?? 0}
            incoming={detailEdges.incoming}
            outgoing={detailEdges.outgoing}
            focusOnly={focusOnly}
            usageCount={selectedUsage}
            onToggleFocus={() => {
              setForcedVisibleId(null)
              setFocusOnly((current) => !current)
            }}
            onSelect={handleSelect}
            onFilterTrace={() => {
              setPluginFilter(selectedNode.id)
            }}
            onClose={clearSelection}
          />
        ) : null}
        {stats.nodes === 0 ? (
          <p className="graph-empty">
            {typeof window.dex === 'undefined'
              ? '浏览器预览等待 Electron 数据服务；请先运行 pnpm dev。'
              : '等待插件树数据：dsh 宿主就绪后，节点将在这里生长。'}
          </p>
        ) : null}
        {stats.nodes > 0 && stats.visibleNodes === 0 ? (
          <div className="graph-empty">
            <p>当前过滤/聚焦下没有可见节点。</p>
            <button type="button" className="graph-chip graph-chip-reset" onClick={resetFilters}>
              重置过滤
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
