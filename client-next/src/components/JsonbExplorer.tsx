import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Braces, ChevronDown, ChevronRight, Filter } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/CopyButton'
import { Select } from '@/components/ui/select'
import { Loading } from '@/components/ui/spinner'
import { getJsonbSchema, type ColumnMeta, type JsonbPath } from '@/lib/api'
import { jsonbAccessor } from '@/lib/filterSql'

const SAMPLE_SIZE = 500

/**
 * JSONB explorer (roadmap §7.3). Samples a json/jsonb column, infers its paths,
 * and turns each into a one-click filter or a copyable `col->'a'->>'b'`
 * accessor. Renders nothing when the table has no json/jsonb columns, so it
 * degrades cleanly for other column types.
 */
export function JsonbExplorer({
  connectionId,
  tableName,
  columns,
  onAddPathFilter,
}: {
  connectionId: string
  tableName: string
  columns: Record<string, ColumnMeta>
  onAddPathFilter: (column: string, path: string[]) => void
}) {
  const jsonColumns = useMemo(
    () =>
      Object.entries(columns)
        .filter(([, m]) => {
          const t = (m.dataType ?? '').toLowerCase()
          return t === 'jsonb' || t === 'json'
        })
        .map(([name]) => name),
    [columns],
  )

  const [open, setOpen] = useState(false)
  const [column, setColumn] = useState<string>(jsonColumns[0] ?? '')
  const active = jsonColumns.includes(column) ? column : jsonColumns[0] ?? ''

  const query = useQuery({
    queryKey: ['jsonb', connectionId, tableName, active, SAMPLE_SIZE],
    queryFn: ({ signal }) =>
      getJsonbSchema(connectionId, tableName, active, SAMPLE_SIZE, signal),
    enabled: open && !!active,
    staleTime: 60_000,
  })

  if (jsonColumns.length === 0) return null

  return (
    <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Braces className="h-3.5 w-3.5" />
        JSONB explorer
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <Select
              value={active}
              onChange={(e) => setColumn(e.target.value)}
              className="h-8 w-48"
              aria-label="JSONB column"
            >
              {jsonColumns.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
            <span className="text-xs text-muted-foreground">
              {query.data
                ? `${query.data.paths.length} paths · sampled ${query.data.sampledRows} rows`
                : `sample size ${SAMPLE_SIZE}`}
            </span>
          </div>

          {query.isLoading && <Loading>Inferring schema…</Loading>}
          {query.error && (
            <p className="text-xs text-destructive">{(query.error as Error).message}</p>
          )}
          {query.data && query.data.paths.length === 0 && (
            <p className="text-xs text-muted-foreground">No keys found in the sampled rows.</p>
          )}

          {query.data && query.data.paths.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-md border border-border bg-card">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-2 py-1.5 font-medium">Path</th>
                    <th className="px-2 py-1.5 font-medium">Type</th>
                    <th className="px-2 py-1.5 font-medium">Coverage</th>
                    <th className="px-2 py-1.5 font-medium">Sample</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {query.data.paths.map((p) => (
                    <PathRow
                      key={p.path}
                      column={active}
                      path={p}
                      onFilter={() => onAddPathFilter(active, p.accessor!)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PathRow({
  column, path, onFilter,
}: {
  column: string
  path: JsonbPath
  onFilter: () => void
}) {
  const filterable = path.accessor != null
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-2 py-1 font-mono text-foreground">{path.path}</td>
      <td className="px-2 py-1 text-muted-foreground">{path.types.join(' | ')}</td>
      <td className="px-2 py-1 text-muted-foreground">
        {Math.round(path.frequency * 100)}%
      </td>
      <td className="max-w-[16rem] truncate px-2 py-1 font-mono text-muted-foreground">
        {path.sample == null ? '—' : String(path.sample)}
      </td>
      <td className="px-2 py-1">
        {filterable ? (
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-7" onClick={onFilter}>
              <Filter className="h-3.5 w-3.5" /> Filter
            </Button>
            <CopyButton text={jsonbAccessor(column, path.accessor!)} label="Copy" />
          </div>
        ) : (
          <span className="block text-right text-[10px] text-muted-foreground/70">in array</span>
        )}
      </td>
    </tr>
  )
}
