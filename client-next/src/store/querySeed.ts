import { create } from 'zustand'

/**
 * One-shot hand-off of SQL into the Query editor. The slow-query drilldown's
 * "Explain" action (roadmap §6.2) sets a seed, opens the Query tab, and
 * navigates there; the QueryRunner applies the seed and clears it. A store
 * (rather than a route search param) keeps a potentially long, multi-line query
 * out of the URL and applies even when the Query tab is already mounted.
 */
interface QuerySeedState {
  seed: string | null
  setSeed: (sql: string) => void
  clear: () => void
}

export const useQuerySeedStore = create<QuerySeedState>()((set) => ({
  seed: null,
  setSeed: (sql) => set({ seed: sql }),
  clear: () => set({ seed: null }),
}))
