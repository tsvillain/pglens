import { create } from 'zustand'

/**
 * Per-tab Advanced toggle state (roadmap §5.1). Advanced Mode is per-tab, not
 * per-app, so mode and the edited SQL live keyed by tab id — flipping back to
 * No-code preserves the SQL the user was editing. Cleared when the tab closes.
 */
export type TabMode = 'nocode' | 'advanced'

interface TabModeState {
  /** Active mode per tab id. Absent → 'nocode' (the default surface). */
  mode: Record<string, TabMode>
  /** Preserved Advanced SQL per tab id, so a flip-back-and-forth keeps edits. */
  sql: Record<string, string>
  setMode: (tabId: string, mode: TabMode) => void
  setSql: (tabId: string, sql: string) => void
  /** Drop a tab's state when it closes. */
  reset: (tabId: string) => void
}

export const useTabModeStore = create<TabModeState>()((set) => ({
  mode: {},
  sql: {},
  setMode: (tabId, mode) =>
    set((s) => ({ mode: { ...s.mode, [tabId]: mode } })),
  setSql: (tabId, sql) =>
    set((s) => ({ sql: { ...s.sql, [tabId]: sql } })),
  reset: (tabId) =>
    set((s) => {
      const { [tabId]: _m, ...mode } = s.mode
      const { [tabId]: _q, ...sql } = s.sql
      return { mode, sql }
    }),
}))
