import { describe, expect, it } from 'vitest'
import { relativeTime } from './relative-time'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 7, 2, 0, 0)

describe('relativeTime', () => {
  it('缺省与非正数返回 null（不渲染时间格）', () => {
    expect(relativeTime(undefined)).toBeNull()
    expect(relativeTime(0)).toBeNull()
    expect(relativeTime(-1)).toBeNull()
  })

  it('一分钟内显示「刚刚」', () => {
    expect(relativeTime(NOW - 1, NOW)).toBe('刚刚')
    expect(relativeTime(NOW - 59_000, NOW)).toBe('刚刚')
  })

  it('小时内按分钟、天内按小时、月内按天', () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe('5 分钟前')
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3 小时前')
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe('2 天前')
  })

  it('超过一个月退回绝对日期（避免「87 天前」这种没人换算的文案）', () => {
    expect(relativeTime(NOW - 90 * DAY, NOW)).toBe('2026/07/09')
  })
})
