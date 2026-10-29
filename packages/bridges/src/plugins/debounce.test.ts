import { describe, expect, it, vi } from 'vitest'
import { createDebouncedBatch } from './debounce'

describe('createDebouncedBatch', () => {
  it('窗口内多次 schedule 只触发一次', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const batch = createDebouncedBatch(fn, 120)

      batch.schedule()
      vi.advanceTimersByTime(50)
      batch.schedule()
      batch.schedule()
      vi.advanceTimersByTime(69)
      expect(fn).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('持续风暴不会饿死：固定窗口到期即执行', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const batch = createDebouncedBatch(fn, 120)

      for (let i = 0; i < 200; i += 1) {
        batch.schedule()
        vi.advanceTimersByTime(10)
      }
      expect(fn).toHaveBeenCalledTimes(16)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush 后可再次调度；cancel 丢弃未执行窗口', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const batch = createDebouncedBatch(fn, 100)

      batch.schedule()
      vi.advanceTimersByTime(100)
      expect(fn).toHaveBeenCalledTimes(1)

      batch.schedule()
      batch.cancel()
      vi.advanceTimersByTime(1000)
      expect(fn).toHaveBeenCalledTimes(1)

      batch.flushNow()
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
