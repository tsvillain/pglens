import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { previewWhere } from '@/lib/filterSql'
import {
  exportTableData,
  type ApiError,
  type ColumnMeta,
  type ExportFormat,
  type FilterGroup,
  type SortEntry,
} from '@/lib/api'

interface ExportMenuProps {
  connectionId: string
  tableName: string
  columns: Record<string, ColumnMeta>
  filter: FilterGroup
  sort: SortEntry[]
}

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL' },
]

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function previewOrderBy(sort: SortEntry[]): string {
  if (sort.length === 0) return ''
  return (
    'ORDER BY ' +
    sort.map((s) => `${quoteIdent(s.column)} ${s.direction.toUpperCase()}`).join(', ')
  )
}

/**
 * "Export" toolbar action. Streams the current table view (filter + sort +
 * chosen columns) to disk as CSV, JSON, or a SQL `INSERT` script. Honors the
 * roadmap's "every no-code action exposes Show SQL" principle with a preview
 * of the exact SELECT the server runs.
 */
export function ExportMenu({
  connectionId,
  tableName,
  columns,
  filter,
  sort,
}: ExportMenuProps) {
  const allColumns = useMemo(() => Object.keys(columns), [columns])

  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allColumns))
  const [showSql, setShowSql] = useState(false)

  // Preserve column order; only the chosen ones, in their ordinal order.
  const chosen = useMemo(
    () => allColumns.filter((c) => selected.has(c)),
    [allColumns, selected],
  )

  const sqlPreview = useMemo(() => {
    if (chosen.length === 0) return ''
    const cols = chosen.map(quoteIdent).join(', ')
    const where = previewWhere(filter)
    const order = previewOrderBy(sort)
    return [`SELECT ${cols}`, `FROM ${quoteIdent(tableName)}`, where, order]
      .filter(Boolean)
      .join('\n')
  }, [chosen, filter, sort, tableName])

  const exportMut = useMutation({
    mutationFn: () =>
      exportTableData(connectionId, tableName, format, {
        filter,
        sort,
        columns: chosen.length === allColumns.length ? null : chosen,
      }),
    onSuccess: () => setOpen(false),
  })

  const toggle = (col: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      return next
    })

  const allSelected = selected.size === allColumns.length
  const error = exportMut.error as ApiError | null

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Download className="h-4 w-4" /> Export
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (!exportMut.isPending) setOpen(false)
        }}
        title={`Export ${tableName}`}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={exportMut.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => exportMut.mutate()}
              disabled={chosen.length === 0 || exportMut.isPending}
            >
              {exportMut.isPending ? (
                <>
                  <Spinner className="text-xs" /> Exporting…
                </>
              ) : (
                `Export ${format.toUpperCase()}`
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-medium">Format</label>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFormat(f.id)}
                  className={
                    'rounded px-3 py-1 text-sm transition-colors ' +
                    (format === f.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium">
                Columns ({chosen.length}/{allColumns.length})
              </label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(allColumns))
                }
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {allColumns.map((col) => (
                <label key={col} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(col)}
                    onChange={() => toggle(col)}
                  />
                  <span className="truncate font-mono text-xs">{col}</span>
                </label>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Exports every row matching the current filter and sort — not just
            the visible page.
          </p>

          {chosen.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowSql((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showSql ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                Show SQL
              </button>
              {showSql && (
                <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
                  {sqlPreview}
                </pre>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {error.message}
            </div>
          )}
        </div>
      </Dialog>
    </>
  )
}
