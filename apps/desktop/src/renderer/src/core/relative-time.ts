/**
 * 相对时间（会话行的尾部时间标签）。
 *
 * dsh 的会话行用 10px 的紧凑相对时间（`sessionRow .time`），我们沿用同样的信息密度：
 * 「刚刚 / N 分钟前 / N 小时前 / N 天前」，更久就退回 `YYYY/MM/DD`。
 */

export function relativeTime(timestamp: number | undefined, now = Date.now()): string | null {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return null
  const delta = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}/${month}/${dayOfMonth}`
}
