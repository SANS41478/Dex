/**
 * dsh Session / SessionProjections 的最小只读镜像（接触面只允许出现在本目录）。
 *
 * 与 `contract.ts` 同模式：不 import 任何 dsh 包，靠结构化镜像获得编译期检查；
 * 真实宿主里由薄适配（M2-02 探针 / 未来 host 入口）传入。
 */
import type { ZodType } from 'zod'

/** `SessionEvent` 的最小形状：`{ type, seq, time, data }`。 */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  /** epoch 毫秒（dsh `SessionEvent.time`），协议 `at` 的时间来源。 */
  readonly time: number
  readonly data: unknown
}

/** `SessionHeader` 的最小形状（投影 init 用）。 */
export interface SessionHeaderLike {
  readonly id: string
}

/** 会话最小操作面：M2-02 探针用 `append` 合成事件。 */
export interface SessionLike {
  readonly id: string
  append(type: string, data: unknown): unknown
}

export interface SessionCreateOptionsLike {
  readonly meta?: { readonly cwd?: string } | undefined
}

/**
 * `ctx.sessions` 服务最小投影（dsh-session 的 **SessionStore**：
 * `create(id?, options?)` 同步返回已进入 store 的会话；省略 id 时由 store 生成）。
 */
export interface SessionsServiceLike {
  create(id: string | undefined, options?: SessionCreateOptionsLike): SessionLike
  list?(): Iterable<SessionLike>
}

/** `ctx.sessionProjections.register` 的定义形状（子集：不含 dsh 类型表合并）。 */
export interface ProjectionDefinitionLike<S> {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: ZodType<S>
  readonly init: (header: SessionHeaderLike, inheritedEventCount: number) => S
  readonly apply: (state: S, event: SessionEventLike) => S
  /**
   * 可选客户端视图（`wire`）。dsh 只在 `wire` 存在时触发 `onChanged`：
   * host-only 单元（无 wire）不会进入变更流，只能靠 `stateOf` 轮询。
   */
  readonly wire?: {
    readonly viewSchema: ZodType
    readonly view: (state: S) => unknown
  }
}

/** 变更流回调：每个提交事件、每个 view 引用变化的单元一次。 */
export type ProjectionChangeListenerLike = (
  session: SessionLike,
  key: string,
  value: unknown,
  seq: number,
) => void

/** `ctx.sessionProjections` 服务最小投影。 */
export interface SessionProjectionsLike {
  register<S>(definition: ProjectionDefinitionLike<S>): () => void
  stateOf(session: SessionLike, key: string): unknown
  onChanged(listener: ProjectionChangeListenerLike): () => void
}
