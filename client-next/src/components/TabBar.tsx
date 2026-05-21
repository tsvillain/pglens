import { useEffect } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { X, Home, Table as TableIcon, Terminal, GitBranch } from 'lucide-react'

import { cn } from '@/lib/utils'
import { tabId, tabLabel, tabRoute, useTabsStore, type Tab } from '@/store/tabs'

function routeToTab(pathname: string): Tab {
  if (pathname === '/' || pathname === '') return { kind: 'home' }
  if (pathname.startsWith('/tables/')) {
    return { kind: 'table', tableName: decodeURIComponent(pathname.slice('/tables/'.length)) }
  }
  if (pathname === '/query') return { kind: 'query' }
  if (pathname === '/schema') return { kind: 'schema' }
  return { kind: 'home' }
}

function tabIcon(t: Tab) {
  switch (t.kind) {
    case 'table': return TableIcon
    case 'query': return Terminal
    case 'schema': return GitBranch
    case 'home': return Home
  }
}

export function TabBar() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const sync = useTabsStore((s) => s.syncFromRoute)
  const close = useTabsStore((s) => s.close)

  // Mirror URL → tabs so back/forward + deep links register as tabs.
  useEffect(() => {
    sync(routeToTab(pathname))
  }, [pathname, sync])

  if (tabs.length === 0) return null

  return (
    <div className="flex items-center gap-px overflow-x-auto border-b border-border bg-card/50 px-2 pt-1.5">
      {tabs.map((t) => {
        const id = tabId(t)
        const Icon = tabIcon(t)
        const isActive = id === activeId
        return (
          <div
            key={id}
            className={cn(
              'group flex items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-xs',
              isActive
                ? 'border-border bg-background'
                : 'border-transparent text-muted-foreground hover:bg-accent',
            )}
          >
            <button
              onClick={() => navigate({ to: tabRoute(t) })}
              className="flex items-center gap-2"
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="max-w-[180px] truncate">{tabLabel(t)}</span>
            </button>
            <button
              onClick={() => {
                const next = close(id)
                navigate({ to: next ? tabRoute(next) : '/' })
              }}
              className="rounded p-0.5 opacity-0 transition hover:bg-accent group-hover:opacity-100"
              aria-label={`Close ${tabLabel(t)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
