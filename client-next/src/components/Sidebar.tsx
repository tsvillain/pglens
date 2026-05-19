import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { Database, GitBranch, Plus, Search, Table as TableIcon, Terminal, Eye } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import {
  listConnections,
  listSchemas,
  listTables,
  type Connection,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/store/connection'

export function Sidebar() {
  const activeId = useConnectionStore((s) => s.activeConnectionId)
  const setActive = useConnectionStore((s) => s.setActive)
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => listConnections(signal).then((r) => r.connections),
    refetchInterval: 15_000,
  })

  // Auto-pick the first connection if none selected.
  const resolvedActiveId =
    activeId && connections.data?.some((c) => c.id === activeId)
      ? activeId
      : connections.data?.[0]?.id ?? null

  const tables = useQuery({
    queryKey: ['tables', resolvedActiveId],
    queryFn: ({ signal }) =>
      listTables(resolvedActiveId!, signal).then((r) => r.tables),
    enabled: !!resolvedActiveId,
  })

  const schemas = useQuery({
    queryKey: ['schemas', resolvedActiveId],
    queryFn: ({ signal }) =>
      listSchemas(resolvedActiveId!, signal).then((r) => r.schemas),
    enabled: !!resolvedActiveId,
  })

  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const filteredTables = useMemo(() => {
    if (!tables.data) return []
    const q = search.trim().toLowerCase()
    if (!q) return tables.data
    return tables.data.filter((t) => t.name.toLowerCase().includes(q))
  }, [tables.data, search])

  const activeConn: Connection | undefined = connections.data?.find(
    (c) => c.id === resolvedActiveId,
  )

  return (
    <aside className="flex h-screen w-72 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 text-base font-semibold tracking-tight"
        >
          <Database className="h-4 w-4 text-primary" />
          pglens
          <span className="rounded-sm border border-border bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
            v3
          </span>
        </Link>
      </div>

      <Section
        title="Connections"
        action={
          <Button
            size="icon"
            variant="ghost"
            title="New connection"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        }
      >
        {connections.isLoading && <Hint>Loading…</Hint>}
        {connections.error && (
          <Hint className="text-destructive">
            {(connections.error as Error).message}
          </Hint>
        )}
        {connections.data?.length === 0 && (
          <Hint>No active connections. Open / to add one.</Hint>
        )}
        <ul className="space-y-1">
          {connections.data?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setActive(c.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                  c.id === resolvedActiveId &&
                    'bg-accent text-accent-foreground',
                )}
              >
                <span className="truncate">{c.name || c.id}</span>
                {c.id === resolvedActiveId && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {activeConn && (
        <Section title="Schema">
          <Select
            value={activeConn.schema ?? 'public'}
            onChange={() => {
              /* TODO: PATCH /api/connections/:id/schema */
            }}
          >
            {schemas.data?.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            )) ?? <option>public</option>}
          </Select>
          <Link
            to="/schema"
            className={cn(
              'mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/schema' }) &&
                'bg-accent text-accent-foreground',
            )}
          >
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            Visualize
          </Link>
          <Link
            to="/query"
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
              !!matchRoute({ to: '/query' }) &&
                'bg-accent text-accent-foreground',
            )}
          >
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            Query
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
            placeholder="Filter tables…"
            className="h-8 pl-7 text-sm"
            disabled={!resolvedActiveId}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {!resolvedActiveId && <Hint>Pick a connection above.</Hint>}
          {tables.isLoading && <Hint>Loading tables…</Hint>}
          {tables.error && (
            <Hint className="text-destructive">
              {(tables.error as Error).message}
            </Hint>
          )}
          {tables.data && filteredTables.length === 0 && (
            <Hint>No tables match.</Hint>
          )}
          <ul className="space-y-0.5">
            {filteredTables.map((t) => {
              const params = { tableName: t.name }
              const isActive = !!matchRoute({
                to: '/tables/$tableName',
                params,
              })
              return (
                <li key={t.name}>
                  <button
                    onClick={() =>
                      navigate({ to: '/tables/$tableName', params })
                    }
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent',
                      isActive && 'bg-accent text-accent-foreground',
                    )}
                  >
                    {t.type === 'view' ? (
                      <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <TableIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{t.name}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </Section>
      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </aside>
  )
}

function Section({
  title,
  action,
  children,
  className,
  bodyClassName,
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

function Hint({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>
  )
}
