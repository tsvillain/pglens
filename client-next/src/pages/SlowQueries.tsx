import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronDown, ChevronRight, Copy, Database, Gauge, Play, RefreshCw, RotateCcw,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { ExplainPlanDialog } from '@/components/ExplainPlanDialog'
import { Select } from '@/components/ui/select'
import { Loading, Spinner } from '@/components/ui/spinner'
import {
  enableStatements, getSlowStatements, resetStatements,
  type SlowStatement, type StatementsResponse, type StatementSort,
} from '@/lib/api'
import { buildExplainSql } from '@/lib/explainSql'
import { formatBytes, formatCount, formatMs, toNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/store/connection'
import { useQuerySeedStore } from '@/store/querySeed'
import { useTabsStore } from '@/store/tabs'

// pg_stat_statements counts IO in blocks; convert to bytes for display using
// the default block size (BLCKSZ). Non-default builds are rare and only skew
// the human-readable size, never the block counts themselves.
const BLOCK_BYTES = 8192

const SORTS: { value: StatementSort; label: string }[] = [
  { value: 'total_exec_time', label: 'Total time' },
  { value: 'mean_exec_time', label: 'Mean time' },
  { value: 'calls', label: 'Calls' },
]

export function SlowQueries() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const qc = useQueryClient()
  const [sort, setSort] = useState<StatementSort>('total_exec_time')
  const [confirmReset, setConfirmReset] = useState(false)

  const stmts = useQuery({
    queryKey: ['slow-queries', connectionId, sort],
    queryFn: ({ signal }) => getSlowStatements(connectionId!, sort, undefined, signal),
    enabled: !!connectionId,
    placeholderData: (prev) => prev,
  })

  const enableMut = useMutation({
    mutationFn: () => enableStatements(connectionId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slow-queries', connectionId] }),
  })

  const resetMut = useMutation({
    mutationFn: () => resetStatements(connectionId!),
    onSuccess: () => {
      setConfirmReset(false)
      qc.invalidateQueries({ queryKey: ['slow-queries', connectionId] })
    },
  })

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  const data = stmts.data
  const ready = data?.status === 'ready'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Slow queries</h1>
          <p className="text-xs text-muted-foreground">
            Aggregated by <code className="font-mono">pg_stat_statements</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ready && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Sort by
                <Select
                  className="w-36"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as StatementSort)}
                >
                  {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </Select>
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => stmts.refetch()}
                disabled={stmts.isFetching}
                title="Refresh"
              >
                {stmts.isFetching ? <Spinner aria-label="Refreshing" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmReset(true)}
                title="Discard all collected statistics"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset stats
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {stmts.isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loading>Loading query statistics…</Loading>
          </div>
        )}

        {stmts.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {(stmts.error as Error).message}
          </div>
        )}

        {data && data.status !== 'ready' && (
          <EnablePrompt
            response={data}
            onEnable={() => enableMut.mutate()}
            pending={enableMut.isPending}
            error={enableMut.error ? (enableMut.error as Error).message : null}
          />
        )}

        {ready && <StatementsTable statements={data.statements} />}
      </div>

      <ConfirmResetDialog
        open={confirmReset}
        pending={resetMut.isPending}
        error={resetMut.error ? (resetMut.error as Error).message : null}
        onConfirm={() => resetMut.mutate()}
        onClose={() => {
          if (!resetMut.isPending) {
            resetMut.reset()
            setConfirmReset(false)
          }
        }}
      />
    </div>
  )
}

// ---- Enable / not-loaded prompt ---------------------------------------------

function EnablePrompt({
  response, onEnable, pending, error,
}: {
  response: StatementsResponse
  onEnable: () => void
  pending: boolean
  error: string | null
}) {
  const notLoaded = response.status === 'not_loaded'
  const unavailable = response.status === 'not_installed' && !response.available
  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {notLoaded
              ? 'pg_stat_statements is installed but not loaded'
              : 'pg_stat_statements is not enabled'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {notLoaded ? (
              <>
                The extension is created, but its library isn’t in{' '}
                <code className="font-mono">shared_preload_libraries</code>, so it
                isn’t collecting yet. Add it and restart Postgres:
              </>
            ) : unavailable ? (
              <>
                This server doesn’t ship the <code className="font-mono">pg_stat_statements</code>{' '}
                contrib module, so it can’t be enabled from here. Install the
                Postgres contrib package on the server, then reload.
              </>
            ) : (
              <>
                This view needs the <code className="font-mono">pg_stat_statements</code>{' '}
                extension. Enabling it runs:
              </>
            )}
          </p>

          {notLoaded ? (
            <code className="mt-3 block rounded-md bg-muted px-3 py-2 font-mono text-xs">
              # postgresql.conf{'\n'}shared_preload_libraries = 'pg_stat_statements'
            </code>
          ) : (
            <code className="mt-3 block rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {response.ddl ?? 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'}
            </code>
          )}

          {!notLoaded && !unavailable && (
            <>
              <p className="mt-3 text-xs text-muted-foreground">
                Requires a superuser. Collection also needs the library in{' '}
                <code className="font-mono">shared_preload_libraries</code> (set
                at install for most distributions).
              </p>
              <div className="mt-3 flex items-center gap-3">
                <Button size="sm" onClick={onEnable} disabled={pending}>
                  {pending && <Spinner aria-label="Enabling" />}
                  Enable pg_stat_statements
                </Button>
                {error && <span className="text-xs text-destructive">{error}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Statements table -------------------------------------------------------

function StatementsTable({ statements }: { statements: SlowStatement[] }) {
  if (statements.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No statements recorded yet. Run some queries, then refresh.
      </p>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-card text-muted-foreground">
          <tr className="border-b border-border">
            <Th className="w-8" />
            <Th>Query</Th>
            <Th className="text-right">Calls</Th>
            <Th className="text-right">Total</Th>
            <Th className="text-right">Mean</Th>
            <Th className="text-right" title="Estimated 95th percentile (mean + 1.64·stddev)">p95 est.</Th>
            <Th className="text-right">Rows</Th>
          </tr>
        </thead>
        <tbody>
          {statements.map((s) => (
            <StatementRow key={s.queryid} stmt={s} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatementRow({ stmt }: { stmt: SlowStatement }) {
  const [open, setOpen] = useState(false)
  const query = stmt.query?.trim() || '—'
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/50 align-top hover:bg-accent/50"
        onClick={() => setOpen((o) => !o)}
      >
        <Td className="text-muted-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </Td>
        <Td className="max-w-0">
          <code className="block truncate font-mono text-[11px]" title={query}>{query}</code>
        </Td>
        <Td className="whitespace-nowrap text-right tabular-nums">{formatCount(stmt.calls)}</Td>
        <Td className="whitespace-nowrap text-right tabular-nums font-medium">{formatMs(stmt.total_exec_time)}</Td>
        <Td className="whitespace-nowrap text-right tabular-nums">{formatMs(stmt.mean_exec_time)}</Td>
        <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{formatMs(stmt.p95_exec_time_est)}</Td>
        <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{formatCount(stmt.rows)}</Td>
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-muted/30">
          <td />
          <td colSpan={6} className="px-3 py-3">
            <Drilldown stmt={stmt} />
          </td>
        </tr>
      )}
    </>
  )
}

function Drilldown({ stmt }: { stmt: SlowStatement }) {
  const navigate = useNavigate()
  const open = useTabsStore((s) => s.open)
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const [copied, setCopied] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const query = stmt.query?.trim() ?? ''

  // EXPLAIN integration (roadmap §6.2): hand the statement to the Query editor
  // ready to run.
  const explain = () => {
    useQuerySeedStore.getState().setSeed(buildExplainSql(query))
    open({ kind: 'query' })
    navigate({ to: '/query' })
  }

  const copy = () => {
    void navigator.clipboard?.writeText(query).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const cacheHit = cacheHitRatio(stmt.shared_blks_hit, stmt.shared_blks_read)

  return (
    <div className="space-y-3">
      <code className="block max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background px-3 py-2 font-mono text-[11px]">
        {query || '—'}
      </code>

      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <Metric label="Calls" value={formatCount(stmt.calls)} />
        <Metric label="Total time" value={formatMs(stmt.total_exec_time)} />
        <Metric label="Mean" value={formatMs(stmt.mean_exec_time)} />
        <Metric label="Std dev" value={formatMs(stmt.stddev_exec_time)} />
        <Metric label="Min" value={formatMs(stmt.min_exec_time)} />
        <Metric label="p95 (est.)" value={formatMs(stmt.p95_exec_time_est)} hint="mean + 1.64·stddev" />
        <Metric label="Max" value={formatMs(stmt.max_exec_time)} />
        <Metric label="Rows / call" value={formatCount(perCall(stmt.rows, stmt.calls))} />
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <Metric label="Cache hit" value={cacheHit == null ? '—' : `${cacheHit.toFixed(1)}%`} />
        <Metric label="Shared read" value={formatBytes(blocksToBytes(stmt.shared_blks_read))} />
        <Metric label="Shared written" value={formatBytes(blocksToBytes(stmt.shared_blks_written))} />
        <Metric label="Temp read / write" value={`${formatBytes(blocksToBytes(stmt.temp_blks_read))} / ${formatBytes(blocksToBytes(stmt.temp_blks_written))}`} />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPlanOpen(true)}
          disabled={!query || !connectionId}
          title="Visualize the plan (EXPLAIN, estimates only — the query is not run)"
        >
          <Gauge className="h-3.5 w-3.5" />
          Visualize plan
        </Button>
        <Button size="sm" variant="outline" onClick={explain} disabled={!query}>
          <Play className="h-3.5 w-3.5" />
          Explain in editor
        </Button>
        <Button size="sm" variant="ghost" onClick={copy} disabled={!query}>
          <Copy className="h-3.5 w-3.5" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {connectionId && (
        <ExplainPlanDialog
          open={planOpen}
          onClose={() => setPlanOpen(false)}
          connectionId={connectionId}
          sql={query}
          title="Query plan"
        />
      )}
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )
}

// ---- Reset confirm ----------------------------------------------------------

function ConfirmResetDialog({
  open, pending, error, onConfirm, onClose,
}: {
  open: boolean
  pending: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reset query statistics?"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Keep
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            {pending && <Spinner aria-label="Resetting" />}
            Reset stats
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        This runs{' '}
        <code className="font-mono text-foreground">pg_stat_statements_reset()</code>,
        discarding every recorded statement for the whole server. Stats start
        accumulating again from zero.
      </p>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </Dialog>
  )
}

// ---- Small bits -------------------------------------------------------------

function Th({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return <th className={cn('px-3 py-1.5 font-medium', className)} title={title}>{children}</th>
}

function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={cn('px-3 py-1.5', className)} title={title}>{children}</td>
}

function blocksToBytes(blocks: number | string | null | undefined): number | null {
  const n = toNum(blocks)
  return n == null ? null : n * BLOCK_BYTES
}

function cacheHitRatio(
  hit: number | string | null | undefined,
  read: number | string | null | undefined,
): number | null {
  const h = toNum(hit) ?? 0
  const r = toNum(read) ?? 0
  const total = h + r
  return total === 0 ? null : (h / total) * 100
}

function perCall(
  total: number | string | null | undefined,
  calls: number | string | null | undefined,
): number | null {
  const t = toNum(total)
  const c = toNum(calls)
  if (t == null || c == null || c === 0) return null
  return t / c
}
