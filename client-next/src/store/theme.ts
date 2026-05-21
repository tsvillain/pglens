import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  setTheme: (t: Theme) => void
}

export function resolveEffective(theme: Theme): EffectiveTheme {
  if (theme === 'system') {
    if (typeof window === 'undefined') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolveEffective(theme) === 'dark')
}

/**
 * Subscribe to the resolved theme. Recomputes when the user toggles, and
 * when the OS-level preference flips while theme is set to 'system'.
 */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(
    (cb) => {
      const unsubStore = useThemeStore.subscribe(cb)
      const mq = typeof window !== 'undefined'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
      mq?.addEventListener('change', cb)
      return () => {
        unsubStore()
        mq?.removeEventListener('change', cb)
      }
    },
    () => resolveEffective(useThemeStore.getState().theme),
    () => 'light',
  )
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (t) => {
        applyTheme(t)
        set({ theme: t })
      },
    }),
    {
      name: 'pglens-v3-theme',
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme)
      },
    },
  ),
)

// Reapply when the system preference changes (only meaningful if theme === 'system').
if (typeof window !== 'undefined') {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      const { theme } = useThemeStore.getState()
      if (theme === 'system') applyTheme('system')
    })
}
