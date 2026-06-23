import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, History, Trash2, X } from 'lucide-react'

import { Dropdown } from '@/components/ui/dropdown'
import { Spinner } from '@/components/ui/spinner'
import {
  clearQueryHistory,
  deleteQueryHistoryEntry,
  listQueryHistory,
  type QueryHistoryEntry,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const HISTORY_LIMIT = 100

interface QueryHistoryMenuProps {
  connectionId: string
  /** Load an entry's SQL back into the editor. */
  onLoad: (sql: string) => void
}

/** Compact "12s ago" / "4m ago" / "3h ago" / "2d ago" label. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function firstLine(sql: string): string {
  const trimmed = sql.trim()
  const nl = trimmed.indexOf('\n')
  return nl === -1 ? trimmed : `${trimmed.slice(0, nl)} …`
}

/**
 * Per-connection query history (roadmap §5.5). A dropdown of recent runs;
 * clicking one reloads its SQL into the editor. Entries are written by
 * `SqlConsole` after each run.
 */
export function QueryHistoryMenu({ connectionId, onLoad }: QueryHistoryMenuProps) {
  const qc = useQueryClient()
  const historyKey = ['query-history', connectionId] as const

  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: ({ signal }) =>
      listQueryHistory(connectionId, HISTORY_LIMIT, signal).then((r) => r.entries),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteQueryHistoryEntry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: historyKey }),
  })

  const clearMut = useMutation({
    mutationFn: () => clearQueryHistory(connectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: historyKey }),
  })

  const entries = historyQuery.data ?? []

  return (
    <Dropdown
      align="end"
      className="w-[30rem]"
      trigger={({ open }) => (
        <span
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent',
            open && 'bg-accent',
          )}
          title="Query history (this connection)"
        >
          <History className="h-3.5 w-3.5" />
          History
        </span>
      )}
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent queries
        </span>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm('Clear all query history for this connection?')) {
                clearMut.mutate()
              }
            }}
            className="text-xs text-muted-foreground hover:text-destructive"
          >
            Clear all
          </button>
        )}
      </div>
      <div className="my-1 border-t border-border" />

      <div className="max-h-[24rem] overflow-y-auto">
        {historyQuery.isLoading && (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            <Spinner aria-label="Loading history" /> Loading…
          </div>
        )}
        {historyQuery.error && (
          <div className="px-2 py-2 text-xs text-destructive">
            {(historyQuery.error as Error).message}
          </div>
        )}
        {!historyQuery.isLoading && entries.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No history yet. Run a query to start recording.
          </div>
        )}
        <ul className="space-y-0.5">
          {entries.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              onLoad={() => onLoad(entry.sql)}
              onDelete={() => deleteMut.mutate(entry.id)}
            />
          ))}
        </ul>
      </div>
    </Dropdown>
  )
}

function HistoryRow({
  entry,
  onLoad,
  onDelete,
}: {
  entry: QueryHistoryEntry
  onLoad: () => void
  onDelete: () => void
}) {
  const meta = [
    timeAgo(entry.executedAt),
    entry.durationMs != null ? `${entry.durationMs} ms` : null,
    entry.success
      ? entry.rowCount != null
        ? `${entry.rowCount} row${entry.rowCount === 1 ? '' : 's'}`
        : null
      : 'failed',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="group flex items-stretch gap-1 rounded hover:bg-accent">
      <button
        type="button"
        onClick={onLoad}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
        title={entry.error ?? 'Load this query into the editor'}
      >
        <span className="flex items-center gap-1.5">
          {entry.success ? (
            <Check className="h-3 w-3 shrink-0 text-emerald-500" />
          ) : (
            <X className="h-3 w-3 shrink-0 text-destructive" />
          )}
          <span className="truncate font-mono text-xs">{firstLine(entry.sql)}</span>
        </span>
        <span className="truncate pl-4 text-[11px] text-muted-foreground">
          {meta}
          {!entry.success && entry.error ? ` — ${entry.error}` : ''}
        </span>
      </button>
      <button
        type="button"
        aria-label="Delete history entry"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
