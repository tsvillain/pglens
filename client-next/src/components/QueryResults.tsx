import { useMemo, useState } from 'react'
import { CheckCircle2, Download, Gauge } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { DataGrid, type SortState } from '@/components/DataGrid'
import { JsonViewer } from '@/components/JsonViewer'
import {
  type ColumnMeta,
  type ExplainTiming,
  type QueryResult,
  type StatementResult,
} from '@/lib/api'
import { pgTypeName } from '@/lib/pgTypes'
import { downloadResult, type ResultExportFormat } from '@/lib/resultExport'
import { sortRows } from '@/lib/sortRows'
import { cn } from '@/lib/utils'

/**
 * Derive grid column metadata from one statement's result. The server can't
 * supply PK/FK info for arbitrary SQL, so columns are plain; the type OID is
 * resolved to a name so the grid still picks the right cell renderer.
 */
function buildColumns(result: StatementResult): Record<string, ColumnMeta> {
  const cols: Record<string, ColumnMeta> = {}
  const names =
    result.fields.length > 0
      ? result.fields.map((f) => f.name)
      : result.rows[0]
        ? Object.keys(result.rows[0])
        : []
  for (const name of names) {
    const f = result.fields.find((x) => x.name === name)
    cols[name] = {
      dataType: pgTypeName(f?.dataTypeID),
      isPrimaryKey: false,
      isForeignKey: false,
      foreignKeyRef: null,
      isUnique: false,
    }
  }
  return cols
}

/** Short label for a result tab, e.g. "SELECT · 12" or "INSERT · 3". */
function resultLabel(result: StatementResult): string {
  const verb = result.command?.split(' ')[0] || 'Result'
  const count = result.rowCount ?? result.rows.length
  return `${verb} · ${count}`
}

/**
 * Renders the outcome of a query run (roadmap §5.4):
 *   - one result tab per statement of a multi-statement script
 *   - each result in the shared no-code DataGrid (sorting, JSON cells), with
 *     CSV / JSON export of the rows in hand
 *   - or, when EXPLAIN ANALYZE was toggled, the parse/plan/execute timing
 *     breakdown instead of a grid
 */
export function QueryResults({
  result,
  baseName = 'query-result',
}: {
  result: QueryResult
  baseName?: string
}) {
  if (result.timing) {
    return <TimingBreakdown timing={result.timing} totalMs={result.durationMs} />
  }
  return <ResultTabs results={result.results} baseName={baseName} />
}

function ResultTabs({
  results,
  baseName,
}: {
  results: StatementResult[]
  baseName: string
}) {
  const [active, setActive] = useState(0)
  // Per-tab client-side sort (the result is already in memory — no re-query).
  const [sortByTab, setSortByTab] = useState<Record<number, SortState>>({})

  const safeActive = Math.min(active, Math.max(results.length - 1, 0))
  const current = results[safeActive]
  const sort = sortByTab[safeActive] ?? []

  const columns = useMemo(() => (current ? buildColumns(current) : {}), [current])
  const sortedRows = useMemo(
    () => (current ? sortRows(current.rows, sort) : []),
    [current, sort],
  )

  if (!current) {
    return <p className="text-sm text-muted-foreground">Statement completed.</p>
  }

  const fileBase =
    results.length > 1 ? `${baseName}-${safeActive + 1}` : baseName

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {results.length > 1 && (
        <div
          role="tablist"
          aria-label="Query results"
          className="flex shrink-0 flex-wrap gap-1"
        >
          {results.map((r, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === safeActive}
              onClick={() => setActive(i)}
              className={cn(
                'rounded border px-2.5 py-1 text-xs transition',
                i === safeActive
                  ? 'border-border bg-background text-foreground shadow-sm'
                  : 'border-transparent bg-muted/40 text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="text-muted-foreground">{i + 1}.</span>{' '}
              {resultLabel(r)}
            </button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {current.command ? `${current.command} · ` : ''}
          {current.rowCount ?? current.rows.length} rows · {current.durationMs} ms
        </span>
        {current.rows.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            <ExportButton
              format="csv"
              onClick={() =>
                downloadResult('csv', fileBase, Object.keys(columns), sortedRows)
              }
            />
            <ExportButton
              format="json"
              onClick={() =>
                downloadResult('json', fileBase, Object.keys(columns), sortedRows)
              }
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {current.rows.length > 0 ? (
          <DataGrid
            rows={sortedRows}
            columns={columns}
            sort={sort}
            onSortChange={(next) =>
              setSortByTab((prev) => ({ ...prev, [safeActive]: next }))
            }
          />
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            {current.command && !/^SELECT/i.test(current.command)
              ? `${current.command} · ${current.rowCount ?? 0} row${(current.rowCount ?? 0) === 1 ? '' : 's'} affected`
              : 'No rows returned'}{' '}
            · {current.durationMs} ms
          </p>
        )}
      </div>
    </div>
  )
}

function ExportButton({
  format,
  onClick,
}: {
  format: ResultExportFormat
  onClick: () => void
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      title={`Export this result as ${format.toUpperCase()}`}
    >
      <Download className="h-3.5 w-3.5" /> {format.toUpperCase()}
    </Button>
  )
}

/**
 * Parse / plan / execute timing breakdown from EXPLAIN ANALYZE (roadmap §5.4).
 * Postgres reports planning and execution time; "parse" isn't separately
 * exposed, so total wall-clock stands in as the third figure. The raw plan is
 * available behind "View plan" for inspection (full visualizer is §6.3).
 */
function TimingBreakdown({
  timing,
  totalMs,
}: {
  timing: ExplainTiming
  totalMs: number
}) {
  const [showPlan, setShowPlan] = useState(false)
  const fmt = (ms: number | null) => (ms == null ? '—' : `${ms.toFixed(2)} ms`)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Gauge className="h-4 w-4" />
        <span className="font-medium text-foreground">EXPLAIN ANALYZE</span>
      </div>
      <div className="grid max-w-md grid-cols-3 gap-2">
        <Stat label="Planning" value={fmt(timing.planningMs)} />
        <Stat label="Execution" value={fmt(timing.executionMs)} />
        <Stat label="Total" value={`${totalMs} ms`} />
      </div>
      {timing.plan != null && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowPlan(true)}
          >
            View plan
          </Button>
        </div>
      )}
      <Dialog
        open={showPlan}
        onClose={() => setShowPlan(false)}
        title="Query plan"
        className="max-w-2xl"
      >
        {timing.plan != null && <JsonViewer value={timing.plan} />}
      </Dialog>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-sm font-medium text-foreground">{value}</div>
    </div>
  )
}
