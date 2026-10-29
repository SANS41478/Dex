import { useCallback, useEffect, useState } from 'react'

/** 用户偏好：跟随系统 / 强制浅色 / 强制暗色 */
export type ThemePreference = 'system' | 'light' | 'dark'
/** 实际生效的主题（system 已解析为具体值） */
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'dex-theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readPreference(): ThemePreference {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
  return isPreference(raw) ? raw : 'system'
}

export function systemTheme(): ResolvedTheme {
  return globalThis.matchMedia?.(LIGHT_QUERY).matches === true ? 'light' : 'dark'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
}

export interface ThemeController {
  readonly preference: ThemePreference
  readonly resolved: ResolvedTheme
  readonly setPreference: (next: ThemePreference) => void
  readonly cycle: () => void
}

const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

export function useTheme(): ThemeController {
  const [preference, setPreference] = useState<ThemePreference>(readPreference)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readPreference()))

  // 偏好变化：写 storage、解析主题、落到 DOM
  useEffect(() => {
    const next = resolveTheme(preference)
    setResolved(next)
    applyTheme(next)
    globalThis.localStorage?.setItem(STORAGE_KEY, preference)
  }, [preference])

  // 仅 system 模式需要跟随系统外观的实时变化
  useEffect(() => {
    if (preference !== 'system') return
    const media = globalThis.matchMedia(LIGHT_QUERY)
    const onChange = (): void => {
      const next = systemTheme()
      setResolved(next)
      applyTheme(next)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  const setPreferenceStable = useCallback((next: ThemePreference): void => {
    setPreference(next)
  }, [])

  const cycle = useCallback((): void => {
    setPreference((prev) => CYCLE[prev])
  }, [])

  return { preference, resolved, setPreference: setPreferenceStable, cycle }
}
