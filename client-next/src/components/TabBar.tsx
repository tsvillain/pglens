import { useEffect, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { X, Home, Table as TableIcon, Terminal, GitBranch, GitCompare, Activity, Timer, Lightbulb, Network, Puzzle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { rollbackTx } from '@/lib/api'
import { cn } from '@/lib/utils'
import { tabId, tabLabel, tabRoute, useTabsStore, type Tab } from '@/store/tabs'
import { useTabModeStore } from '@/store/tabMode'
import { useTransactionStore } from '@/store/transaction'

function routeToTab(pathname: string): Tab {
  if (pathname === '/' || pathname === '') return { kind: 'home' }
  if (pathname.startsWith('/tables/')) {
    return { kind: 'table', tableName: decodeURIComponent(pathname.slice('/tables/'.length)) }
  }
  if (pathname === '/query') return { kind: 'query' }
  if (pathname === '/schema') return { kind: 'schema' }
  if (pathname === '/erd') return { kind: 'erd' }
  if (pathname === '/operations') return { kind: 'operations' }
  if (pathname === '/slow-queries') return { kind: 'slow-queries' }
  if (pathname === '/index-assistant') return { kind: 'index-assistant' }
  if (pathname === '/schema-diff') return { kind: 'schema-diff' }
  if (pathname === '/extensions') return { kind: 'extensions' }
  return { kind: 'home' }
}

function tabIcon(t: Tab) {
  switch (t.kind) {
    case 'table': return TableIcon
    case 'query': return Terminal
    case 'schema': return GitBranch
    case 'erd': return Network
    case 'operations': return Activity
    case 'slow-queries': return Timer
    case 'index-assistant': return Lightbulb
    case 'schema-diff': return GitCompare
    case 'extensions': return Puzzle
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

  // Per-tab open-transaction state (roadmap §5.3): drives the "T" badge and the
  // close-confirmation modal.
  const txOpen = useTransactionStore((s) => s.open)
  const txConnId = useTransactionStore((s) => s.connectionId)
  const resetTx = useTransactionStore((s) => s.reset)

  // Tab id awaiting a close confirmation because it holds an open transaction.
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState(false)

  // Mirror URL → tabs so back/forward + deep links register as tabs.
  useEffect(() => {
    sync(routeToTab(pathname))
  }, [pathname, sync])

  // Drop a tab's per-tab state and close it, navigating to whatever's left.
  const finalizeClose = (id: string) => {
    useTabModeStore.getState().reset(id)
    resetTx(id)
    const next = close(id)
    navigate({ to: next ? tabRoute(next) : '/' })
  }

  // Closing a tab with an open transaction asks first (roadmap §5.3).
  const requestClose = (id: string) => {
    if (txOpen[id]) setPendingClose(id)
    else finalizeClose(id)
  }

  const confirmRollbackClose = async () => {
    const id = pendingClose
    if (!id) return
    setRollingBack(true)
    try {
      const cid = txConnId[id]
      // Best-effort: roll back the held transaction so its backend is freed
      // immediately. The server's idle timeout reclaims it regardless if this
      // fails (e.g. the connection is already gone).
      if (cid) await rollbackTx(cid, id)
    } catch {
      /* ignore — idle timeout is the backstop */
    } finally {
      setRollingBack(false)
      setPendingClose(null)
      finalizeClose(id)
    }
  }

  if (tabs.length === 0) return null

  return (
    <div className="flex items-center gap-px overflow-x-auto border-b border-border bg-card/50 px-2 pt-1.5">
      {tabs.map((t) => {
        const id = tabId(t)
        const Icon = tabIcon(t)
        const isActive = id === activeId
        const hasTx = !!txOpen[id]
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
              {hasTx && (
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-amber-500/20 text-[10px] font-bold text-amber-600 dark:text-amber-400"
                  title="Open transaction"
                  aria-label="Open transaction"
                >
                  T
                </span>
              )}
            </button>
            <button
              onClick={() => requestClose(id)}
              className="rounded p-0.5 opacity-0 transition hover:bg-accent group-hover:opacity-100"
              aria-label={`Close ${tabLabel(t)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}

      <Dialog
        open={pendingClose !== null}
        onClose={() => !rollingBack && setPendingClose(null)}
        title="Discard open transaction?"
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingClose(null)}
              disabled={rollingBack}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={confirmRollbackClose}
              disabled={rollingBack}
            >
              {rollingBack && <Spinner aria-label="Rolling back" />}
              Roll back & close
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          This tab has an uncommitted transaction. Closing it will{' '}
          <span className="font-medium text-foreground">ROLLBACK</span> the
          transaction and discard its changes.
        </p>
      </Dialog>
    </div>
  )
}
