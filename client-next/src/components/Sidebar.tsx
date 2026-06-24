import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Link, useMatchRoute, useNavigate, useRouterState,
} from '@tanstack/react-router'
import {
  Activity, Bookmark, ChevronDown, ChevronRight, Download, Eye, GitBranch,
  GitCompare, Lightbulb, MoreVertical, Pencil, Plus, Power, Search,
  Table as TableIcon, Terminal, Timer,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Loading, Spinner } from '@/components/ui/spinner'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { ExportProgressToast } from '@/components/ExportProgressToast'
import { ThemeToggle } from '@/components/ThemeToggle'
import {
  disconnect, downloadBackup, listConnections, listSchemas, listTables,
  listViews, patchSchema, type Connection, type SavedView,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/store/connection'
import { useTabsStore } from '@/store/tabs'

export function Sidebar() {
  const qc = useQueryClient()
  const activeId = useConnectionStore((s) => s.activeConnectionId)
  const setActive = useConnectionStore((s) => s.setActive)
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  // Active view id is sourced from URL search params so the nested sidebar
  // entry highlights without needing a window.location peek.
  const activeViewId = useRouterState({
    select: (s) =>
      (s.location.search as { view?: string } | undefined)?.view ?? null,
  })
  const openTab = useTabsStore((s) => s.open)

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => listConnections(signal).then((r) => r.connections),
    refetchInterval: 15_000,
  })

  const resolvedActiveId =
    activeId && connections.data?.some((c) => c.id === activeId)
      ? activeId
      : connections.data?.[0]?.id ?? null

  // The sidebar resolves a fallback connection (first available) for its own
  // UI, but pages like TableView read `activeConnectionId` straight from the
  // store. On a fresh deep-link load that value is null/stale, so persist the
  // resolved id back to the store to keep every consumer in sync.
  useEffect(() => {
    if (resolvedActiveId && resolvedActiveId !== activeId) {
      setActive(resolvedActiveId)
    }
  }, [resolvedActiveId, activeId, setActive])

  const tables = useQuery({
    queryKey: ['tables', resolvedActiveId],
    queryFn: ({ signal }) => listTables(resolvedActiveId!, signal).then((r) => r.tables),
    enabled: !!resolvedActiveId,
  })

  const schemas = useQuery({
    queryKey: ['schemas', resolvedActiveId],
    queryFn: ({ signal }) => listSchemas(resolvedActiveId!, signal).then((r) => r.schemas),
    enabled: !!resolvedActiveId,
  })

  // One bulk fetch per connection. The TableView page also reads this cache
  // entry (`['views', connectionId, tableName]` filtered), so we keep this
  // un-filtered fetch separate but share the connection cache via the
  // TanStack Query cache.
  const allViews = useQuery({
    queryKey: ['views', resolvedActiveId],
    queryFn: ({ signal }) =>
      listViews({ connectionId: resolvedActiveId! }, signal).then((r) => r.views),
    enabled: !!resolvedActiveId,
  })

  const viewsByTable = useMemo(() => {
    const out: Record<string, SavedView[]> = {}
    for (const v of allViews.data ?? []) {
      (out[v.tableName] ??= []).push(v)
    }
    return out
  }, [allViews.data])

  // Tables that the user has expanded to reveal their nested views. Kept
  // local — collapsing is a UI affordance, not durable state.
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const toggleExpanded = (name: string) =>
    setExpandedTables((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const patchSchemaMut = useMutation({
    mutationFn: ({ id, schema }: { id: string; schema: string }) =>
      patchSchema(id, schema),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      qc.invalidateQueries({ queryKey: ['tables', resolvedActiveId] })
      qc.invalidateQueries({ queryKey: ['schema', resolvedActiveId] })
    },
  })

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnect(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      if (resolvedActiveId === id) setActive(null)
    },
  })

  const [exportProgress, setExportProgress] = useState<
    { bytes: number; currentTable?: string } | null
  >(null)
  const exportAbortRef = useRef<AbortController | null>(null)

  const exportMut = useMutation({
    mutationFn: (id: string) => {
      exportAbortRef.current?.abort()
      const controller = new AbortController()
      exportAbortRef.current = controller
      setExportProgress({ bytes: 0 })
      return downloadBackup(
        id,
        `pglens_${activeConn?.name ?? 'backup'}.sql`,
        (p) => setExportProgress({ bytes: p.bytes, currentTable: p.currentTable }),
        controller.signal,
      )
    },
    onSettled: () => {
      setExportProgress(null)
      exportAbortRef.current = null
    },
  })

  const [search, setSearch] = useState('')
  const filteredTables = useMemo(() => {
    if (!tables.data) return []
    const q = search.trim().toLowerCase()
    if (!q) return tables.data
    return tables.data.filter((t) => t.name.toLowerCase().includes(q))
  }, [tables.data, search])

  const [dialogState, setDialogState] = useState<{ open: boolean; edit?: Connection }>(
    { open: false },
  )
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null)

  const activeConn: Connection | undefined = connections.data?.find(
    (c) => c.id === resolvedActiveId,
  )

  return (
    <aside className="flex h-screen w-72 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <Link
          to="/"
          onClick={() => openTab({ kind: 'home' })}
          className="flex items-center gap-2"
        >
          <span className="font-logo text-xl leading-none tracking-wide">
            pglens
          </span>
        </Link>
        <ThemeToggle />
      </div>

      <Section
        title="Connections"
        action={
          <Button
            size="icon"
            variant="ghost"
            title="New connection"
            onClick={() => setDialogState({ open: true })}
          >
            <Plus className="h-4 w-4" />
          </Button>
        }
      >
        {connections.isLoading && <Hint><Loading>Loading connections…</Loading></Hint>}
        {connections.error && (
          <Hint className="text-destructive">
            {(connections.error as Error).message}
          </Hint>
        )}
        {connections.data?.length === 0 && (
          <Hint>No active connections. Click + to add one.</Hint>
        )}
        <ul className="space-y-1">
          {connections.data?.map((c) => (
            <li key={c.id} className="relative">
              <div
                className={cn(
                  'group flex items-center gap-1 rounded-md px-1 hover:bg-accent',
                  c.id === resolvedActiveId && 'bg-accent text-accent-foreground',
                )}
              >
                <button
                  onClick={() => setActive(c.id)}
                  className="flex flex-1 items-center gap-2 px-1 py-1.5 text-left text-sm"
                >
                  {c.id === resolvedActiveId && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  )}
                  <span className="truncate">{c.name || c.id}</span>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={() => setMenuOpenFor(menuOpenFor === c.id ? null : c.id)}
                  aria-label="Connection actions"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </div>
              {menuOpenFor === c.id && (
                <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <MenuItem
                    icon={Pencil}
                    onClick={() => {
                      setMenuOpenFor(null)
                      setDialogState({ open: true, edit: c })
                    }}
                  >
                    Edit
                  </MenuItem>
                  <MenuItem
                    icon={Power}
                    onClick={() => {
                      setMenuOpenFor(null)
                      disconnectMut.mutate(c.id)
                    }}
                  >
                    Disconnect
                  </MenuItem>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {activeConn && (
        <Section title="Schema">
          <Select
            value={activeConn.schema ?? 'public'}
            onChange={(e) =>
              patchSchemaMut.mutate({ id: activeConn.id, schema: e.target.value })
            }
          >
            {schemas.data?.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            )) ?? <option>public</option>}
          </Select>
          <Link
            to="/schema"
            onClick={() => openTab({ kind: 'schema' })}
            className={cn(
              'mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/schema' }) && 'bg-accent text-accent-foreground',
            )}
          >
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            Visualize
          </Link>
          <Link
            to="/query"
            onClick={() => openTab({ kind: 'query' })}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/query' }) && 'bg-accent text-accent-foreground',
            )}
          >
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            Query
          </Link>
          <Link
            to="/schema-diff"
            onClick={() => openTab({ kind: 'schema-diff' })}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/schema-diff' }) && 'bg-accent text-accent-foreground',
            )}
          >
            <GitCompare className="h-3.5 w-3.5 text-muted-foreground" />
            Diff &amp; migrate
          </Link>
          <button
            onClick={() => exportMut.mutate(activeConn.id)}
            disabled={exportMut.isPending}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
          >
            {exportMut.isPending ? (
              <Spinner className="text-muted-foreground" aria-label="Exporting" />
            ) : (
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            {exportMut.isPending ? 'Exporting backup…' : 'Export backup'}
          </button>
        </Section>
      )}

      {activeConn && (
        <Section title="Operations">
          <Link
            to="/operations"
            onClick={() => openTab({ kind: 'operations' })}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/operations' }) && 'bg-accent text-accent-foreground',
            )}
          >
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            Live activity
          </Link>
          <Link
            to="/slow-queries"
            onClick={() => openTab({ kind: 'slow-queries' })}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/slow-queries' }) && 'bg-accent text-accent-foreground',
            )}
          >
            <Timer className="h-3.5 w-3.5 text-muted-foreground" />
            Slow queries
          </Link>
          <Link
            to="/index-assistant"
            onClick={() => openTab({ kind: 'index-assistant' })}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/index-assistant' }) && 'bg-accent text-accent-foreground',
            )}
          >
            <Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />
            Index assistant
          </Link>
        </Section>
      )}

      <Section
        title={`Tables${tables.data ? ` · ${tables.data.length}` : ''}`}
        className="flex min-h-0 flex-1 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-2"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tables (⌘K)…"
            className="h-8 pl-7 text-sm"
            disabled={!resolvedActiveId}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {!resolvedActiveId && <Hint>Pick a connection above.</Hint>}
          {tables.isLoading && <Hint><Loading>Loading tables…</Loading></Hint>}
          {tables.error && (
            <Hint className="text-destructive">{(tables.error as Error).message}</Hint>
          )}
          {tables.data && filteredTables.length === 0 && <Hint>No tables match.</Hint>}
          <ul className="space-y-0.5">
            {filteredTables.map((t) => {
              const params = { tableName: t.name }
              const isActive = !!matchRoute({ to: '/tables/$tableName', params })
              const tableViews = viewsByTable[t.name] ?? []
              const expanded = expandedTables.has(t.name)
              const hasViews = tableViews.length > 0
              return (
                <li key={t.name}>
                  <div
                    className={cn(
                      'group flex items-center gap-0.5 rounded-md hover:bg-accent',
                      isActive && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <button
                      aria-label={expanded ? 'Collapse views' : 'Expand views'}
                      onClick={() => toggleExpanded(t.name)}
                      className={cn(
                        'flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground',
                        !hasViews && 'invisible',
                      )}
                    >
                      {expanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      onClick={() => {
                        openTab({ kind: 'table', tableName: t.name })
                        navigate({ to: '/tables/$tableName', params })
                      }}
                      className="flex flex-1 items-center gap-2 rounded-md py-1 pr-2 text-left text-sm"
                    >
                      {t.type === 'view' ? (
                        <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <TableIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{t.name}</span>
                      {hasViews && (
                        <span className="ml-auto rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                          {tableViews.length}
                        </span>
                      )}
                    </button>
                  </div>
                  {expanded && hasViews && (
                    <ul className="ml-6 mt-0.5 space-y-0.5 border-l border-border pl-2">
                      {tableViews.map((v) => {
                        const isViewActive = isActive && activeViewId === v.id
                        return (
                          <li key={v.id}>
                            <button
                              onClick={() => {
                                openTab({ kind: 'table', tableName: t.name })
                                navigate({
                                  to: '/tables/$tableName',
                                  params,
                                  search: { view: v.id },
                                })
                              }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
                                isViewActive && 'bg-accent text-accent-foreground',
                              )}
                            >
                              <Bookmark className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="truncate">{v.name}</span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </Section>

      {exportProgress && (
        <ExportProgressToast
          bytes={exportProgress.bytes}
          currentTable={exportProgress.currentTable}
          onCancel={() => exportAbortRef.current?.abort()}
        />
      )}

      <ConnectionDialog
        open={dialogState.open}
        edit={
          dialogState.edit
            ? {
                id: dialogState.edit.id,
                name: dialogState.edit.name,
                connectionString: dialogState.edit.connectionString,
                host: dialogState.edit.host,
                port: dialogState.edit.port,
                database: dialogState.edit.database,
                username: dialogState.edit.username,
                sslMode: dialogState.edit.sslMode,
                schema: dialogState.edit.schema,
              }
            : undefined
        }
        onClose={() => setDialogState({ open: false })}
      />
    </aside>
  )
}

function Section({
  title, action, children, className, bodyClassName,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('border-b border-border px-4 py-3', className)}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}

function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>
}

function MenuItem({
  icon: Icon, children, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  )
}
