/**
 * 类型中立的 dsh 接触面（与 dsh 的接触面只允许出现在本目录）。
 *
 * 字段与投影规则对齐官方 `@deepseek-ai/dsh-host-plugin-inventory`
 * （dsh 仓库 `packages/host/plugin-inventory/src/index.ts`），但不 import
 * cordis/dsh 任何包，靠结构化镜像获得编译期检查。
 */

/** cordis 的 FiberState 是跨包 const enum：镜像数值，保持本包零 dsh 依赖。 */
export const DshFiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

export type DshFiberStateValue = (typeof DshFiberState)[keyof typeof DshFiberState]

/** 官方同款相位投影：DISPOSED → null。 */
export type DshFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

const FIBER_PHASE = {
  [DshFiberState.PENDING]: 'pending',
  [DshFiberState.LOADING]: 'loading',
  [DshFiberState.ACTIVE]: 'active',
  [DshFiberState.FAILED]: 'failed',
  [DshFiberState.DISPOSED]: null,
  [DshFiberState.UNLOADING]: 'unloading',
} as const satisfies Record<DshFiberStateValue, DshFiberPhase>

export function toFiberPhase(state: DshFiberStateValue): DshFiberPhase {
  return FIBER_PHASE[state]
}

/** fiber（插件运行实例）的最小只读快照。 */
export interface DshFiberRef {
  /** 注册表内唯一 id；根 fiber 为 0，dispose 后为 null。 */
  readonly uid: number | null
  readonly state: DshFiberStateValue
  /** 声明的依赖键集合（含未解析项）。 */
  readonly inject: Readonly<Record<string, unknown>>
  /**
   * 已解析依赖的提供方投影：服务名 → 提供方 fiber uid（null = 不可定位，如根服务）。
   * 镜像 cordis `Fiber.store`（`Impl.fiber.uid`）的最小视图；M1-03 的 inject 边目标来源。
   */
  readonly store?: Readonly<Record<string, number | null>>
}

/** Loader 条目（一个已配置的插件位）的最小只读快照。 */
export interface DshLoaderEntry {
  /** 稳定 id（嵌套分组条目会带父前缀）。 */
  readonly id: string
  /** entry.options.name：Loader 导入的模块说明符；内建行（如根 include）可能缺省。 */
  readonly moduleName?: string
  /** 分组条目不承载 fiber，映射时跳过（官方同款规则）。 */
  readonly group: boolean
  /** 有效禁用状态（含祖先分组）。 */
  readonly disabled: boolean
  readonly configReadable?: boolean
  readonly configKeys?: readonly string[]
  readonly fiber?: DshFiberRef
}

/** 本包用到的 cordis 事件（签名对齐 dsh 仓库 `vendor/cordis` 与 `vendor/loader`）。 */
export interface DshEventMap {
  'internal/plugin': (fiber: DshFiberRef) => void
  'internal/status': (fiber: DshFiberRef, oldState: DshFiberStateValue) => void
  'loader/entry-init': (entry: DshLoaderEntry) => void
}

export type DshEventName = keyof DshEventMap

/** `on` 的注册选项（镜像 cordis 的 EventOptions 子集）。 */
export interface DshEventOptions {
  /**
   * 绕过上下文过滤：默认监听者只收「自身祖先链」发出的事件；
   * 桥接插件与其它条目是兄弟关系，必须用 `global: true` 才能收到整树事件（实测）。
   */
  readonly global?: boolean
}

/** 桥接用到的最小宿主接触面；真实 cordis ctx 在 M1-04 做薄适配。 */
export interface DshHost {
  readonly loader: {
    entries(): Iterable<DshLoaderEntry>
  }
  /** 注册订阅并返回撤订函数（仍在注册时返回 true，重复调用返回 false）。 */
  on<K extends DshEventName>(
    event: K,
    listener: DshEventMap[K],
    options?: DshEventOptions,
  ): () => boolean
}
