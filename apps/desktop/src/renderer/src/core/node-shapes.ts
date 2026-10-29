import type { GraphNode, NodeStatus, PluginType } from '@dexagent/shared'
import {
  AdditiveBlending,
  CanvasTexture,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three'
import { resolveToken } from './color'

/**
 * 图谱视觉编码：
 * - 类型 = 节点主体的数据色；
 * - 状态 = 外层环 / 光晕；
 * - 连接度 = 大小；
 * - 不再用几何体形状编码类型。
 */
export const TYPE_TOKEN: Record<PluginType, string> = {
  model: '--color-data-1',
  tool: '--color-data-2',
  skill: '--color-data-3',
  scheduler: '--color-data-4',
  sandbox: '--color-data-5',
  other: '--color-text-disabled',
}

export function typeToken(type: PluginType): string {
  return TYPE_TOKEN[type]
}

const STATUS_TOKEN: Record<NodeStatus, string> = {
  active: '--color-status-success',
  inactive: '--color-status-pending',
  error: '--color-status-failed',
}

export function statusToken(status: NodeStatus): string {
  return STATUS_TOKEN[status]
}

export type NodeEmphasis = 'normal' | 'neighbor' | 'hover' | 'linked' | 'selected'

const EMPHASIS_SCALE: Record<NodeEmphasis, number> = {
  normal: 1,
  neighbor: 1.06,
  // 执行流关联（M2-05）：比 hover 略小，但比邻居更强，提示“来自执行流”而非鼠标指向。
  linked: 1.14,
  hover: 1.18,
  selected: 1.42,
}

const EMPHASIS_GLOW: Record<NodeEmphasis, number> = {
  normal: 1,
  neighbor: 1.15,
  linked: 1.32,
  hover: 1.45,
  selected: 1.7,
}

export function emphasisScale(emphasis: NodeEmphasis): number {
  return EMPHASIS_SCALE[emphasis]
}

/** 大小 = 连接度（PRD：大小 = 活跃度；MVP 用注入连接度近似）。 */
export function degreeScale(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return 1
  const ratio = Math.max(0, Math.min(1, degree / maxDegree))
  return 1 + 0.6 * Math.sqrt(ratio)
}

const BREATH_PERIOD_MS = 5_600
const ERROR_BREATH_PERIOD_MS = 3_200
const BREATH_AMPLITUDE = 0.02
const ERROR_BREATH_AMPLITUDE = 0.035

/** 稳定但不连续的相位：同一节点每次刷新保持同样节奏，避免整屏同步跳动。 */
function phaseOf(nodeId: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < nodeId.length; index += 1) {
    hash ^= nodeId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (((hash >>> 0) % 1_000) / 1_000) * Math.PI * 2
}

/** 节点呼吸缩放倍率；inactive 完全静止，active / error 使用不同周期。 */
export function breathingScale(nodeId: string, elapsedMs: number, status: NodeStatus): number {
  if (status === 'inactive') return 1
  const period = status === 'error' ? ERROR_BREATH_PERIOD_MS : BREATH_PERIOD_MS
  const wave = 0.5 + 0.5 * Math.sin((elapsedMs / period) * Math.PI * 2 + phaseOf(nodeId))
  return 1 + (status === 'error' ? ERROR_BREATH_AMPLITUDE : BREATH_AMPLITUDE) * wave
}

/** 光晕呼吸透明度；与缩放同相位，保证“体积”和“光”一起呼吸。 */
export function breathingGlow(nodeId: string, elapsedMs: number, status: NodeStatus): number {
  if (status === 'inactive') return 0.14
  const period = status === 'error' ? ERROR_BREATH_PERIOD_MS : BREATH_PERIOD_MS
  const wave = 0.5 + 0.5 * Math.sin((elapsedMs / period) * Math.PI * 2 + phaseOf(nodeId))
  const base = status === 'error' ? 0.48 : 0.34
  const amplitude = status === 'error' ? 0.26 : 0.16
  return base + amplitude * wave
}

export interface NodeEmphasisView {
  readonly selectedId: string | null
  readonly hoveredId: string | null
  readonly neighbors: ReadonlySet<string>
  /** 执行流选中节点 → 图谱节点弱高亮；与选中/悬浮互不覆盖。 */
  readonly linked?: ReadonlySet<string> | undefined
}

export interface NodeVisualSample {
  readonly scale: number
  readonly type: PluginType
  readonly status: NodeStatus
  readonly glow: number
}

export interface NodeMeshPool {
  readonly obtain: (node: GraphNode, degree: number, maxDegree: number) => Object3D
  readonly applyEmphasis: (view: NodeEmphasisView) => void
  readonly applyBreathing: (elapsedMs: number) => void
  readonly refreshTheme: () => void
  readonly sample: (nodeId: string) => NodeVisualSample | null
  readonly prune: (validIds: ReadonlySet<string>) => void
  readonly dispose: () => void
}

const BASE_RADIUS = 5
const HALO_SCALE = 2

interface NodeEntry {
  readonly group: Group
  readonly body: Mesh
  readonly halo: Sprite | null
  readonly haloMaterial: SpriteMaterial | null
  node: GraphNode
  baseScale: number
  breath: number
  glow: number
}

function createHaloTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context === null) return null
  const center = 64
  const glow = context.createRadialGradient(center, center, 0, center, center, 62)
  glow.addColorStop(0, 'rgba(255,255,255,0.55)')
  glow.addColorStop(0.34, 'rgba(255,255,255,0.2)')
  glow.addColorStop(0.58, 'rgba(255,255,255,0.08)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, 128, 128)
  context.beginPath()
  context.arc(center, center, 39, 0, Math.PI * 2)
  context.strokeStyle = 'rgba(255,255,255,0.85)'
  context.lineWidth = 2.5
  context.shadowColor = 'rgba(255,255,255,0.9)'
  context.shadowBlur = 10
  context.stroke()
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

function emphasisFor(nodeId: string, view: NodeEmphasisView): NodeEmphasis {
  return nodeId === view.selectedId
    ? 'selected'
    : nodeId === view.hoveredId
      ? 'hover'
      : (view.linked?.has(nodeId) ?? false)
        ? 'linked'
        : view.selectedId !== null && view.neighbors.has(nodeId)
          ? 'neighbor'
          : 'normal'
}

export function createNodeMeshPool(): NodeMeshPool {
  const geometry = new IcosahedronGeometry(1, 2)
  const haloTexture = createHaloTexture()
  const bodyMaterials = new Map<string, MeshStandardMaterial>()
  const entries = new Map<string, NodeEntry>()
  let view: NodeEmphasisView = { selectedId: null, hoveredId: null, neighbors: new Set() }

  const bodyMaterialFor = (type: PluginType, emphasis: NodeEmphasis): MeshStandardMaterial => {
    const key = `${type}:${emphasis}`
    const cached = bodyMaterials.get(key)
    if (cached !== undefined) return cached
    const color = resolveToken(typeToken(type))
    const intensity =
      emphasis === 'selected'
        ? 0.44
        : emphasis === 'hover'
          ? 0.36
          : emphasis === 'linked'
            ? 0.28
            : emphasis === 'neighbor'
              ? 0.24
              : 0.18
    const material = new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: intensity,
      roughness: 0.34,
      metalness: 0.28,
      flatShading: true,
    })
    bodyMaterials.set(key, material)
    return material
  }

  const updateEntryVisual = (entry: NodeEntry): void => {
    const emphasis = emphasisFor(entry.node.id, view)
    entry.body.material = bodyMaterialFor(entry.node.type, emphasis)
    entry.group.scale.setScalar(entry.baseScale * emphasisScale(emphasis) * entry.breath)
    if (entry.haloMaterial !== null) {
      entry.haloMaterial.color.set(resolveToken(statusToken(entry.node.status)))
      entry.haloMaterial.opacity = entry.glow * EMPHASIS_GLOW[emphasis]
    }
  }

  const createEntry = (node: GraphNode, baseScale: number): NodeEntry => {
    const haloMaterial =
      haloTexture === null
        ? null
        : new SpriteMaterial({
            map: haloTexture,
            color: resolveToken(statusToken(node.status)),
            transparent: true,
            opacity: breathingGlow(node.id, 0, node.status),
            blending: AdditiveBlending,
            depthWrite: false,
            depthTest: true,
          })
    const halo = haloMaterial === null ? null : new Sprite(haloMaterial)
    if (halo !== null) {
      halo.scale.setScalar(HALO_SCALE)
      halo.renderOrder = -1
    }
    const body = new Mesh(geometry, bodyMaterialFor(node.type, 'normal'))
    const group = new Group()
    if (halo !== null) group.add(halo)
    group.add(body)
    return {
      group,
      body,
      halo,
      haloMaterial,
      node,
      baseScale,
      breath: 1,
      glow: breathingGlow(node.id, 0, node.status),
    }
  }

  const core: NodeMeshPool = {
    obtain(node, degree, maxDegree) {
      const baseScale = BASE_RADIUS * degreeScale(degree, maxDegree)
      const cached = entries.get(node.id)
      if (cached !== undefined) {
        cached.node = node
        cached.baseScale = baseScale
        updateEntryVisual(cached)
        return cached.group
      }
      const entry = createEntry(node, baseScale)
      entries.set(node.id, entry)
      updateEntryVisual(entry)
      return entry.group
    },
    applyEmphasis(next) {
      view = next
      for (const entry of entries.values()) updateEntryVisual(entry)
    },
    applyBreathing(elapsedMs) {
      for (const entry of entries.values()) {
        entry.breath = breathingScale(entry.node.id, elapsedMs, entry.node.status)
        entry.glow = breathingGlow(entry.node.id, elapsedMs, entry.node.status)
        updateEntryVisual(entry)
      }
    },
    refreshTheme() {
      for (const material of bodyMaterials.values()) material.dispose()
      bodyMaterials.clear()
      for (const entry of entries.values()) updateEntryVisual(entry)
    },
    sample(nodeId) {
      const entry = entries.get(nodeId)
      if (entry === undefined) return null
      return {
        scale: entry.group.scale.x,
        type: entry.node.type,
        status: entry.node.status,
        glow: entry.glow,
      }
    },
    prune(validIds) {
      for (const [id, entry] of entries) {
        if (validIds.has(id)) continue
        entry.group.removeFromParent()
        entry.haloMaterial?.dispose()
        entries.delete(id)
      }
    },
    dispose() {
      for (const entry of entries.values()) {
        entry.group.removeFromParent()
        entry.haloMaterial?.dispose()
      }
      entries.clear()
      for (const material of bodyMaterials.values()) material.dispose()
      bodyMaterials.clear()
      geometry.dispose()
      haloTexture?.dispose()
    },
  }
  return core
}
