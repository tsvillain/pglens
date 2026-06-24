import { create } from 'zustand'

export type Tab =
  | { kind: 'table'; tableName: string }
  | { kind: 'query' }
  | { kind: 'schema' }
  | { kind: 'erd' }
  | { kind: 'operations' }
  | { kind: 'slow-queries' }
  | { kind: 'index-assistant' }
  | { kind: 'schema-diff' }
  | { kind: 'home' }

function tabId(t: Tab): string {
  switch (t.kind) {
    case 'table': return `table:${t.tableName}`
    case 'query': return 'query'
    case 'schema': return 'schema'
    case 'erd': return 'erd'
    case 'operations': return 'operations'
    case 'slow-queries': return 'slow-queries'
    case 'index-assistant': return 'index-assistant'
    case 'schema-diff': return 'schema-diff'
    case 'home': return 'home'
  }
}

function tabLabel(t: Tab): string {
  switch (t.kind) {
    case 'table': return t.tableName
    case 'query': return 'Query'
    case 'schema': return 'Schema'
    case 'erd': return 'ERD editor'
    case 'operations': return 'Operations'
    case 'slow-queries': return 'Slow queries'
    case 'index-assistant': return 'Index assistant'
    case 'schema-diff': return 'Schema diff'
    case 'home': return 'Home'
  }
}

function tabRoute(t: Tab): string {
  switch (t.kind) {
    case 'table': return `/tables/${encodeURIComponent(t.tableName)}`
    case 'query': return '/query'
    case 'schema': return '/schema'
    case 'erd': return '/erd'
    case 'operations': return '/operations'
    case 'slow-queries': return '/slow-queries'
    case 'index-assistant': return '/index-assistant'
    case 'schema-diff': return '/schema-diff'
    case 'home': return '/'
  }
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  open: (t: Tab) => Tab
  close: (id: string) => Tab | null
  setActive: (id: string) => void
  syncFromRoute: (t: Tab) => void
}

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeId: null,
  open: (t) => {
    const id = tabId(t)
    const { tabs } = get()
    if (!tabs.find((x) => tabId(x) === id)) {
      set({ tabs: [...tabs, t], activeId: id })
    } else {
      set({ activeId: id })
    }
    return t
  },
  close: (id) => {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((x) => tabId(x) === id)
    if (idx < 0) return null
    const next = tabs.filter((_, i) => i !== idx)
    let nextActive: string | null = activeId
    if (activeId === id) {
      const fallback = next[idx] ?? next[idx - 1] ?? null
      nextActive = fallback ? tabId(fallback) : null
    }
    set({ tabs: next, activeId: nextActive })
    return nextActive ? next.find((x) => tabId(x) === nextActive) ?? null : null
  },
  setActive: (id) => set({ activeId: id }),
  // Called by the router so URL nav (e.g. back/forward, deep links) registers as a tab.
  syncFromRoute: (t) => {
    const id = tabId(t)
    const { tabs } = get()
    if (!tabs.find((x) => tabId(x) === id)) {
      set({ tabs: [...tabs, t], activeId: id })
    } else if (get().activeId !== id) {
      set({ activeId: id })
    }
  },
}))

export { tabId, tabLabel, tabRoute }
