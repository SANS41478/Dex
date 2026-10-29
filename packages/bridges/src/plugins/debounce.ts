/**
 * 固定窗口批量：窗口内多次 `schedule()` 只触发一次 `fn`。
 *
 * 与「重置式防抖」不同：连续事件风暴（dsh HMR 一次改动可产生 200+ 事件）
 * 不会无限推迟执行——首个事件起算 delayMs 后必然 flush。
 */
export interface DebouncedBatch {
  readonly schedule: () => void
  readonly flushNow: () => void
  readonly cancel: () => void
}

export function createDebouncedBatch(fn: () => void, delayMs: number): DebouncedBatch {
  let timer: NodeJS.Timeout | null = null

  return {
    schedule() {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        fn()
      }, delayMs)
    },
    flushNow() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      fn()
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
