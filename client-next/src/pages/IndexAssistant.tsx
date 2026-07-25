import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle, Database, FileSearch, Layers,
  Play, RefreshCw, Table as TableIcon, Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/CopyButton'
import { Loading, Spinner } from '@/components/ui/spinner'
import {
  getIndexAdvice,
  type DuplicateGroup, type RemovableIndex, type SeqScanTable, type UnusedIndex,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatBytes, formatCount, toNum } from '@/lib/format'
import { useConnectionStore } from '@/store/connection'
import { useQuerySeedStore } from '@/store/querySeed'
import { useTabsStore } from '@/store/tabs'

export function IndexAssistant() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)

  const advice = useQuery({
    queryKey: ['index-advice', connectionId],
    queryFn: ({ signal }) => getIndexAdvice(connectionId!, signal),
    enabled: !!connectionId,
    placeholderData: (prev) => prev,
  })

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  const data = advice.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Index assistant</h1>
          <p className="text-xs text-muted-foreground">
            Read-only advice from the catalog · suggestions are never run for you
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => advice.refetch()}
          disabled={advice.isFetching}
          title="Refresh"
        >
          {advice.isFetching ? <Spinner aria-label="Refreshing" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {advice.isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loading>Analyzing indexes…</Loading>
          </div>
        )}

        {advice.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {(advice.error as Error).message}
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <UnusedPanel section={data.unused} />
            <DuplicatePanel section={data.duplicate} />
            <SeqScanPanel section={data.seqScans} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Shared editor hand-off -------------------------------------------------

// Seed SQL into the Query editor and jump there — the user reviews and runs it.
// Reuses the slow-query "Explain in editor" flow; no execute endpoint needed,
// so a destructive DROP is always behind the editor's Run button.
function useOpenInEditor() {
  const navigate = useNavigate()
  const open = useTabsStore((s) => s.open)
  return (sql: string) => {
    useQuerySeedStore.getState().setSeed(sql)
    open({ kind: 'query' })
    navigate({ to: '/query' })
  }
}

// ---- Panels -----------------------------------------------------------------

function Panel({
  title, icon: Icon, count, error, hint, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  count?: number
  error?: string | null
  hint?: string
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
        {hint && <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>}
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

function UnusedPanel({ section }: { section: { data: UnusedIndex[] | null; error: string | null } }) {
  const open = useOpenInEditor()
  const rows = section.data ?? []
  return (
    <Panel
      title="Unused indexes"
      icon={Trash2}
      count={section.error ? undefined : rows.length}
      error={section.error}
      hint="never scanned since stats were last reset"
    >
      {rows.length === 0 ? (
        <Empty>No unused indexes. 🎉</Empty>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.map((ix) => (
            <li key={`${ix.table_name}.${ix.index_name}`} className="px-4 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <code className="font-mono font-medium">{ix.index_name}</code>
                    <span className="text-muted-foreground">on</span>
                    <code className="font-mono text-muted-foreground">{ix.table_name}</code>
                  </div>
                  <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" title={ix.indexdef}>
                    {ix.indexdef}
                  </code>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    {formatBytes(ix.size_bytes)}
                  </span>
                  <CopyButton text={ix.drop_ddl} label="Copy DDL" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    title="Review the DROP in the editor"
                    onClick={() => open(ix.drop_ddl)}
                  >
                    <Play className="h-3.5 w-3.5" />
                    Review drop
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function DuplicatePanel({ section }: { section: { data: DuplicateGroup[] | null; error: string | null } }) {
  const open = useOpenInEditor()
  const groups = section.data ?? []
  return (
    <Panel
      title="Duplicate indexes"
      icon={Layers}
      count={section.error ? undefined : groups.length}
      error={section.error}
      hint="identical column list — keep one, drop the rest"
    >
      {groups.length === 0 ? (
        <Empty>No duplicate indexes.</Empty>
      ) : (
        <ul className="divide-y divide-border/50">
          {groups.map((g) => (
            <li key={g.table_name + g.indexes.map((i) => i.index_name).join(',')} className="px-4 py-2.5">
              <div className="mb-1.5 flex items-center gap-2 text-xs">
                <TableIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <code className="font-mono text-muted-foreground">{g.table_name}</code>
              </div>
              <ul className="space-y-1.5 pl-5">
                {g.indexes.map((ix: RemovableIndex, i) => (
                  <li key={ix.index_name} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs">
                        <code className="font-mono font-medium">{ix.index_name}</code>
                        {i === 0 && (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            largest — keep
                          </span>
                        )}
                      </div>
                      <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground" title={ix.indexdef}>
                        {ix.indexdef}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {formatBytes(ix.size_bytes)}
                      </span>
                      <CopyButton text={ix.drop_ddl} label="Copy DDL" />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        title="Review the DROP in the editor"
                        onClick={() => open(ix.drop_ddl)}
                      >
                        <Play className="h-3.5 w-3.5" />
                        Review drop
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function SeqScanPanel({ section }: { section: { data: SeqScanTable[] | null; error: string | null } }) {
  const navigate = useNavigate()
  const open = useTabsStore((s) => s.open)
  const rows = section.data ?? []
  const goToTable = (name: string) => {
    open({ kind: 'table', tableName: name })
    navigate({ to: '/tables/$tableName', params: { tableName: name } })
  }
  return (
    <Panel
      title="Tables relying on sequential scans"
      icon={FileSearch}
      count={section.error ? undefined : rows.length}
      error={section.error}
      hint="missing-index candidates"
    >
      {rows.length === 0 ? (
        <Empty>No tables are leaning on sequential scans.</Empty>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <Th>Table</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right">Seq scans</Th>
                <Th className="text-right">Index scans</Th>
                <Th className="text-right" title="Average rows read per sequential scan">Rows / seq scan</Th>
                <Th className="text-right">Size</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.table_name} className="border-b border-border/50">
                  <Td className="max-w-[14rem] truncate" title={t.table_name}>
                    <code className="font-mono">{t.table_name}</code>
                  </Td>
                  <Td className="text-right tabular-nums">{formatCount(t.n_live_tup)}</Td>
                  <Td className="text-right tabular-nums font-medium">{formatCount(t.seq_scan)}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">{formatCount(t.idx_scan)}</Td>
                  <Td className="text-right tabular-nums">{formatCount(perScan(t.seq_tup_read, t.seq_scan))}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">{formatBytes(t.size_bytes)}</Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      title="Open this table"
                      onClick={() => goToTable(t.table_name)}
                    >
                      <Database className="h-3.5 w-3.5" />
                      Open
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

// ---- Small bits -------------------------------------------------------------

function Th({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return <th className={cn('px-3 py-1.5 font-medium', className)} title={title}>{children}</th>
}

function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={cn('px-3 py-1.5', className)} title={title}>{children}</td>
}

function perScan(
  read: number | string | null | undefined,
  scans: number | string | null | undefined,
): number | null {
  const r = toNum(read)
  const s = toNum(scans)
  if (r == null || s == null || s === 0) return null
  return r / s
}
