import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Select } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { parseCsv, type ParsedCsv } from '@/lib/csv'
import {
  importTableData,
  type ApiError,
  type ColumnMeta,
  type ImportMode,
  type ImportResult,
} from '@/lib/api'

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  connectionId: string
  tableName: string
  columns: Record<string, ColumnMeta>
  /** Called after a successful (non-dry-run) import so the grid can refetch. */
  onImported: () => void
}

const MODES: { id: ImportMode; label: string; hint: string }[] = [
  { id: 'insert', label: 'Insert', hint: 'Plain INSERT. Fails if a row collides with an existing key.' },
  { id: 'skip', label: 'Skip conflicts', hint: 'INSERT … ON CONFLICT DO NOTHING. Colliding rows are skipped.' },
  { id: 'update', label: 'Update on conflict', hint: 'INSERT … ON CONFLICT … DO UPDATE. Colliding rows overwrite the existing row.' },
]

const SKIP = '__skip__'

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Case/underscore-insensitive header match for the mapping auto-guess. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * CSV import wizard. Parses the file in the browser, auto-maps headers to
 * columns by name, lets the user pick a conflict mode, runs a dry run (counts
 * + rollback), then executes inside a server-side transaction. Honors the
 * roadmap's "Show SQL" principle with a preview of the INSERT the server runs.
 */
export function ImportDialog({
  open,
  onClose,
  connectionId,
  tableName,
  columns,
  onImported,
}: ImportDialogProps) {
  const tableColumns = useMemo(() => Object.keys(columns), [columns])
  const pkColumns = useMemo(
    () => tableColumns.filter((c) => columns[c].isPrimaryKey),
    [tableColumns, columns],
  )

  const [fileName, setFileName] = useState<string | null>(null)
  const [rawText, setRawText] = useState<string>('')
  const [hasHeader, setHasHeader] = useState(true)
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  // target column -> CSV header index (or undefined when skipped).
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const [mode, setMode] = useState<ImportMode>('insert')
  const [conflictCols, setConflictCols] = useState<Set<string>>(new Set())
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [showSql, setShowSql] = useState(false)
  const [dryRun, setDryRun] = useState<ImportResult | null>(null)

  const reset = () => {
    setFileName(null)
    setRawText('')
    setHasHeader(true)
    setParsed(null)
    setParseError(null)
    setMapping({})
    setMode('insert')
    setConflictCols(new Set())
    setEmptyAsNull(true)
    setShowSql(false)
    setDryRun(null)
    importMut.reset()
  }

  // (Re)parse `text` and seed the column mapping by header-name match.
  const ingest = (text: string, header: boolean) => {
    try {
      const result = parseCsv(text, { hasHeader: header })
      setParsed(result)
      setParseError(result.rows.length === 0 ? 'No data rows found in the file.' : null)
      const byNorm = new Map(result.headers.map((h, i) => [normalize(h), i]))
      const guess: Record<string, number> = {}
      for (const col of tableColumns) {
        const hit = byNorm.get(normalize(col))
        if (hit !== undefined) guess[col] = hit
      }
      setMapping(guess)
      setConflictCols(new Set(pkColumns.filter((c) => guess[c] !== undefined)))
      setDryRun(null)
    } catch (err) {
      setParsed(null)
      setParseError(err instanceof Error ? err.message : 'Could not parse the CSV file.')
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setFileName(file.name)
    setRawText(text)
    ingest(text, hasHeader)
  }

  const toggleHeader = (next: boolean) => {
    setHasHeader(next)
    if (rawText) ingest(rawText, next)
  }

  // Target columns with a source, in table-column order — the import order.
  const mappedColumns = useMemo(
    () => tableColumns.filter((c) => mapping[c] !== undefined),
    [tableColumns, mapping],
  )

  // Project every parsed row down to the mapped columns, in order.
  const projectedRows = useMemo(() => {
    if (!parsed) return []
    return parsed.rows.map((row) => mappedColumns.map((c) => row[mapping[c]] ?? ''))
  }, [parsed, mappedColumns, mapping])

  const effectiveConflictCols = useMemo(
    () => mappedColumns.filter((c) => conflictCols.has(c)),
    [mappedColumns, conflictCols],
  )

  const sqlPreview = useMemo(() => {
    if (mappedColumns.length === 0) return ''
    const cols = mappedColumns.map(quoteIdent).join(', ')
    const ph = mappedColumns
      .map((c) => {
        const t = (columns[c].dataType || '').toLowerCase()
        return t === 'jsonb' || t === 'json' ? `$?::${t}` : '$?'
      })
      .join(', ')
    let conflict = ''
    if (mode === 'skip') conflict = '\nON CONFLICT DO NOTHING'
    else if (mode === 'update') {
      const target = effectiveConflictCols.map(quoteIdent).join(', ')
      const setCols = mappedColumns.filter((c) => !effectiveConflictCols.includes(c))
      const setList = setCols.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ')
      conflict = `\nON CONFLICT (${target || '…'}) DO ${setList ? `UPDATE SET ${setList}` : 'NOTHING'}`
    }
    return `INSERT INTO ${quoteIdent(tableName)} (${cols})\nVALUES (${ph})${conflict}`
  }, [mappedColumns, columns, mode, effectiveConflictCols, tableName])

  const updateNeedsConflict = mode === 'update' && effectiveConflictCols.length === 0
  const canRun =
    mappedColumns.length > 0 && projectedRows.length > 0 && !updateNeedsConflict

  const basePayload = () => ({
    columns: mappedColumns,
    rows: projectedRows,
    mode,
    conflictColumns: mode === 'update' ? effectiveConflictCols : undefined,
    emptyAsNull,
  })

  const dryRunMut = useMutation({
    mutationFn: () => importTableData(connectionId, tableName, { ...basePayload(), dryRun: true }),
    onSuccess: (r) => setDryRun(r),
  })

  const importMut = useMutation({
    mutationFn: () => importTableData(connectionId, tableName, { ...basePayload(), dryRun: false }),
    onSuccess: () => {
      onImported()
      reset()
      onClose()
    },
  })

  const busy = dryRunMut.isPending || importMut.isPending
  const error = (importMut.error ?? dryRunMut.error) as ApiError | null

  const close = () => {
    if (busy) return
    reset()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Import into ${tableName}`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => dryRunMut.mutate()}
            disabled={!canRun || busy}
          >
            {dryRunMut.isPending ? (
              <>
                <Spinner className="text-xs" /> Checking…
              </>
            ) : (
              'Dry run'
            )}
          </Button>
          <Button onClick={() => importMut.mutate()} disabled={!canRun || busy}>
            {importMut.isPending ? (
              <>
                <Spinner className="text-xs" /> Importing…
              </>
            ) : (
              `Import ${projectedRows.length || ''} rows`
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Step 1 — file */}
        <div>
          <label className="mb-2 block text-sm font-medium">CSV file</label>
          <div className="flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
              <Upload className="h-4 w-4" />
              Choose file
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </label>
            {fileName && (
              <span className="truncate text-xs text-muted-foreground">{fileName}</span>
            )}
          </div>
          {fileName && (
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => toggleHeader(e.target.checked)}
              />
              First row is a header
            </label>
          )}
          {parseError && (
            <p className="mt-2 text-xs text-destructive">{parseError}</p>
          )}
        </div>

        {/* Step 2 — mapping */}
        {parsed && parsed.rows.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium">
              Map columns ({mappedColumns.length}/{tableColumns.length}) ·{' '}
              {parsed.rows.length.toLocaleString()} rows
            </label>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {tableColumns.map((col) => (
                <div key={col} className="flex items-center gap-2 text-sm">
                  <span className="w-1/2 truncate font-mono text-xs">
                    {col}
                    <span className="ml-1 text-muted-foreground">
                      {columns[col].dataType}
                      {columns[col].isPrimaryKey ? ' · pk' : ''}
                    </span>
                  </span>
                  <Select
                    className="w-1/2"
                    value={mapping[col] === undefined ? SKIP : String(mapping[col])}
                    onChange={(e) => {
                      const v = e.target.value
                      setDryRun(null)
                      setMapping((prev) => {
                        const next = { ...prev }
                        if (v === SKIP) delete next[col]
                        else next[col] = Number(v)
                        return next
                      })
                    }}
                  >
                    <option value={SKIP}>— skip —</option>
                    {parsed.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `column_${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3 — mode + options */}
        {mappedColumns.length > 0 && (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium">On conflict</label>
              <div className="space-y-1">
                {MODES.map((m) => (
                  <label key={m.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="import-mode"
                      className="mt-0.5"
                      checked={mode === m.id}
                      onChange={() => {
                        setMode(m.id)
                        setDryRun(null)
                      }}
                    />
                    <span>
                      {m.label}
                      <span className="block text-xs text-muted-foreground">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {mode === 'update' && (
              <div>
                <label className="mb-2 block text-sm font-medium">Conflict key</label>
                <div className="flex flex-wrap gap-3 rounded-md border border-border p-2">
                  {mappedColumns.map((col) => (
                    <label key={col} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={conflictCols.has(col)}
                        onChange={() => {
                          setDryRun(null)
                          setConflictCols((prev) => {
                            const next = new Set(prev)
                            if (next.has(col)) next.delete(col)
                            else next.add(col)
                            return next
                          })
                        }}
                      />
                      <span className="font-mono">{col}</span>
                    </label>
                  ))}
                </div>
                {updateNeedsConflict && (
                  <p className="mt-1 text-xs text-destructive">
                    Pick at least one mapped column as the conflict key (usually the
                    primary key or a unique column).
                  </p>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={emptyAsNull}
                onChange={(e) => {
                  setEmptyAsNull(e.target.checked)
                  setDryRun(null)
                }}
              />
              Treat blank cells as NULL
            </label>

            <div>
              <button
                type="button"
                onClick={() => setShowSql((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showSql ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Show SQL
              </button>
              {showSql && (
                <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
                  {sqlPreview}
                </pre>
              )}
            </div>
          </>
        )}

        {/* Dry-run result */}
        {dryRun && (
          <div className="rounded-md border border-border bg-card p-3 text-xs">
            <p className="mb-1 font-medium">Dry run — no changes were written.</p>
            <ul className="space-y-0.5 text-muted-foreground">
              <li>{dryRun.attempted.toLocaleString()} rows to process</li>
              <li>{dryRun.inserted.toLocaleString()} would be inserted</li>
              {mode === 'update' && <li>{dryRun.updated.toLocaleString()} would be updated</li>}
              {dryRun.conflicts > 0 && (
                <li className={mode === 'insert' ? 'text-destructive' : undefined}>
                  {dryRun.conflicts.toLocaleString()} conflict{dryRun.conflicts === 1 ? '' : 's'}
                  {mode === 'insert' && ' — Insert will fail; switch to Skip or Update'}
                </li>
              )}
            </ul>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {error.message}
            {error.hint && <span className="mt-1 block opacity-80">{error.hint}</span>}
          </div>
        )}
      </div>
    </Dialog>
  )
}
