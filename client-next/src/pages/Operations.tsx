import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity, AlertTriangle, Ban, Database, Lock, Pause, Play,
  RefreshCw, Server, XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Loading, Spinner } from '@/components/ui/spinner'
import {
  cancelBackend, getOperationsOverview, terminateBackend,
  type ActivitySession, type BlockingEntry, type ConnectionStats,
  type DatabaseSize, type OpsSection, type ReplicationEntry, type TableSize,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatBytes, formatDuration } from '@/lib/format'
import { useConnectionStore } from '@/store/connection'

// Roadmap §6.1: "Refresh every 5 seconds while the panel is open."
const REFRESH_MS = 5_000

type BackendAction = { kind: 'cancel' | 'terminate'; pid: number; query: string | null }

export function Operations() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const qc = useQueryClient()
  const [paused, setPaused] = useState(false)
  const [confirm, setConfirm] = useState<BackendAction | null>(null)

  const overview = useQuery({
    queryKey: ['operations', connectionId],
    queryFn: ({ signal }) => getOperationsOverview(connectionId!, signal),
    enabled: !!connectionId,
    // Poll while visible; pausing lets a user inspect a row without it shifting.
    refetchInterval: paused ? false : REFRESH_MS,
    // Keep the prior snapshot on the screen during each refetch so the grids
    // don't blank out every 5 seconds.
    placeholderData: (prev) => prev,
  })

  const actionMut = useMutation({
    mutationFn: ({ kind, pid }: BackendAction) =>
      kind === 'cancel'
        ? cancelBackend(connectionId!, pid)
        : terminateBackend(connectionId!, pid),
    onSuccess: () => {
      setConfirm(null)
      qc.invalidateQueries({ queryKey: ['operations', connectionId] })
    },
  })

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  const data = overview.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Operations</h1>
          <p className="text-xs text-muted-foreground">
            Live server activity · refreshes every {REFRESH_MS / 1000}s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                paused ? 'bg-muted-foreground' : 'animate-pulse bg-emerald-500',
              )}
            />
            {paused ? 'Paused' : 'Live'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => overview.refetch()}
            disabled={overview.isFetching}
            title="Refresh now"
          >
            {overview.isFetching ? (
              <Spinner aria-label="Refreshing" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {overview.isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loading>Loading server activity…</Loading>
          </div>
        )}

        {overview.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {(overview.error as Error).message}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="xl:col-span-2">
              <ConnectionsPanel section={data.connections} />
            </div>
            <ActivityPanel
              section={data.activity}
              busyPid={actionMut.isPending ? actionMut.variables?.pid : undefined}
              onAction={(kind, s) =>
                setConfirm({ kind, pid: s.pid, query: s.query })
              }
            />
            <SizesPanel section={data.sizes} />
            <BlockingPanel section={data.blocking} />
            <ReplicationPanel section={data.replication} />
          </div>
        )}
      </div>

      <ConfirmActionDialog
        action={confirm}
        pending={actionMut.isPending}
        error={actionMut.error ? (actionMut.error as Error).message : null}
        onConfirm={() => confirm && actionMut.mutate(confirm)}
        onClose={() => {
          if (!actionMut.isPending) {
            actionMut.reset()
            setConfirm(null)
          }
        }}
      />
    </div>
  )
}

// ---- Panels -----------------------------------------------------------------

function Panel({
  title, icon: Icon, count, error, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  count?: number
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
        {typeof count === 'number' && (
          <span className="rounded bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1">
        {error ? <ErrorNote message={error} /> : children}
      </div>
    </section>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-xs text-muted-foreground">{children}</p>
}

function ConnectionsPanel({ section }: { section: OpsSection<ConnectionStats> }) {
  const c = section.data
  const pct = c && c.max ? Math.min(100, Math.round((c.total / c.max) * 100)) : 0
  const warn = c?.level === 'warn'
  return (
    <Panel title="Connections" icon={Server} error={section.error}>
      {!c ? (
        <Empty>No connection stats.</Empty>
      ) : (
        <div className="px-4 py-3">
          <div className="mb-2 flex items-end justify-between">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums">{c.total}</span>
              <span className="text-sm text-muted-foreground">/ {c.max ?? '?'} max</span>
              {warn && (
                <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" /> {pct}% used
                </span>
              )}
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <Stat label="active" value={c.active} />
              <Stat label="idle" value={c.idle} />
              <Stat label="idle in txn" value={c.idle_in_transaction} />
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                warn ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex flex-col items-end">
      <span className="font-medium tabular-nums text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  )
}

function ActivityPanel({
  section, busyPid, onAction,
}: {
  section: OpsSection<ActivitySession[]>
  busyPid?: number
  onAction: (kind: 'cancel' | 'terminate', s: ActivitySession) => void
}) {
  const sessions = section.data ?? []
  return (
    <Panel
      title="Active connections"
      icon={Activity}
      count={section.error ? undefined : sessions.length}
      error={section.error}
    >
      {sessions.length === 0 ? (
        <Empty>No active sessions.</Empty>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="border-b border-border">
                <Th>PID</Th>
                <Th>User</Th>
                <Th>State</Th>
                <Th>Wait</Th>
                <Th>Age</Th>
                <Th>Query</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const busy = busyPid === s.pid
                return (
                  <tr key={s.pid} className="border-b border-border/50 align-top">
                    <Td className="tabular-nums">{s.pid}</Td>
                    <Td>{s.usename ?? '—'}</Td>
                    <Td><StateBadge state={s.state} /></Td>
                    <Td>{s.wait_event ? `${s.wait_event_type}: ${s.wait_event}` : '—'}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatDuration(s.age_seconds)}</Td>
                    <Td className="max-w-md">
                      <code className="block truncate font-mono text-[11px] text-muted-foreground" title={s.query ?? ''}>
                        {s.query?.trim() || '—'}
                      </code>
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5"
                          disabled={busy}
                          title="Cancel running query"
                          onClick={() => onAction('cancel', s)}
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-destructive hover:text-destructive"
                          disabled={busy}
                          title="Terminate session"
                          onClick={() => onAction('terminate', s)}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function BlockingPanel({ section }: { section: OpsSection<BlockingEntry[]> }) {
  const rows = section.data ?? []
  return (
    <Panel
      title="Locks & blocking"
      icon={Lock}
      count={section.error ? undefined : rows.length}
      error={section.error}
    >
      {rows.length === 0 ? (
        <Empty>No blocked queries. 🎉</Empty>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.map((r, i) => (
            <li key={`${r.blocked_pid}-${r.blocking_pid}-${i}`} className="px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2 font-medium">
                <span className="rounded bg-destructive/15 px-1.5 py-0.5 tabular-nums text-destructive">
                  {r.blocking_pid}
                </span>
                <span className="text-muted-foreground">blocks</span>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 tabular-nums text-amber-600 dark:text-amber-400">
                  {r.blocked_pid}
                </span>
                {r.wait_event && (
                  <span className="text-muted-foreground">· {r.wait_event_type}: {r.wait_event}</span>
                )}
              </div>
              <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" title={r.blocked_query ?? ''}>
                waiting: {r.blocked_query?.trim() || '—'}
              </code>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function ReplicationPanel({ section }: { section: OpsSection<ReplicationEntry[]> }) {
  const rows = section.data ?? []
  return (
    <Panel
      title="Replication"
      icon={Database}
      count={section.error ? undefined : rows.length}
      error={section.error}
    >
      {rows.length === 0 ? (
        <Empty>No connected standbys.</Empty>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <Th>Client</Th>
                <Th>State</Th>
                <Th>Sync</Th>
                <Th>Lag</Th>
                <Th>Replay lag</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pid} className="border-b border-border/50">
                  <Td>{r.client_addr ?? r.application_name ?? `pid ${r.pid}`}</Td>
                  <Td>{r.state ?? '—'}</Td>
                  <Td>{r.sync_state ?? '—'}</Td>
                  <Td className="tabular-nums">{formatBytes(r.lag_bytes)}</Td>
                  <Td className="tabular-nums">{formatDuration(r.replay_lag_seconds)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function SizesPanel({ section }: { section: OpsSection<{ database: DatabaseSize; tables: TableSize[] }> }) {
  const sizes = section.data
  const tables = sizes?.tables ?? []
  return (
    <Panel
      title="Database & table sizes"
      icon={Database}
      error={section.error}
    >
      {!sizes ? (
        <Empty>No size data.</Empty>
      ) : (
        <>
          <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs text-muted-foreground">{sizes.database?.name ?? 'database'}</span>
            <span className="text-sm font-semibold tabular-nums">
              {sizes.database ? formatBytes(sizes.database.bytes) : '—'}
            </span>
          </div>
          {tables.length === 0 ? (
            <Empty>No tables in this schema.</Empty>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr className="border-b border-border">
                    <Th>Table</Th>
                    <Th className="text-right">Total</Th>
                    <Th className="text-right">Heap</Th>
                    <Th className="text-right">Indexes</Th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map((t) => (
                    <tr key={t.name} className="border-b border-border/50">
                      <Td className="max-w-[12rem] truncate" title={t.name}>{t.name}</Td>
                      <Td className="text-right tabular-nums">{formatBytes(t.total_bytes)}</Td>
                      <Td className="text-right tabular-nums text-muted-foreground">{formatBytes(t.table_bytes)}</Td>
                      <Td className="text-right tabular-nums text-muted-foreground">{formatBytes(t.index_bytes)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

// ---- Confirm dialog ---------------------------------------------------------

function ConfirmActionDialog({
  action, pending, error, onConfirm, onClose,
}: {
  action: BackendAction | null
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const isTerminate = action?.kind === 'terminate'
  return (
    <Dialog
      open={action !== null}
      onClose={onClose}
      title={isTerminate ? 'Terminate session?' : 'Cancel running query?'}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Keep
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending && <Spinner aria-label="Working" />}
            {isTerminate ? 'Terminate' : 'Cancel query'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {isTerminate ? (
          <>
            This runs{' '}
            <code className="font-mono text-foreground">pg_terminate_backend({action?.pid})</code>,
            dropping the entire session. Any open transaction is rolled back.
          </>
        ) : (
          <>
            This runs{' '}
            <code className="font-mono text-foreground">pg_cancel_backend({action?.pid})</code>,
            stopping the current query but keeping the session connected.
          </>
        )}
      </p>
      {action?.query?.trim() && (
        <code className="mt-3 block max-h-32 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {action.query.trim()}
        </code>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </Dialog>
  )
}

// ---- Small bits -------------------------------------------------------------

function StateBadge({ state }: { state: string | null }) {
  const s = state ?? 'unknown'
  const color =
    s === 'active'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : s.startsWith('idle in transaction')
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-muted text-muted-foreground'
  return (
    <span className={cn('inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium', color)}>
      {s}
    </span>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn('px-3 py-1.5 font-medium', className)}>{children}</th>
}

function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={cn('px-3 py-1.5', className)} title={title}>{children}</td>
}
