import { lazy, Suspense, useMemo, useRef, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Play, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Loading, Spinner } from '@/components/ui/spinner'
import { DataGrid } from '@/components/DataGrid'
import { runQuery, type QueryResult, type ColumnMeta } from '@/lib/api'
import { useEffectiveTheme } from '@/store/theme'

const MonacoEditor = lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default })),
)

/**
 * Derive grid column metadata from a raw query result. The server can't supply
 * PK/FK info for arbitrary SQL, so everything is plain and unsorted.
 */
function buildColumnsFromResult(result: QueryResult): Record<string, ColumnMeta> {
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
      dataType: f?.dataTypeID ? `oid:${f.dataTypeID}` : '',
      isPrimaryKey: false,
      isForeignKey: false,
      foreignKeyRef: null,
      isUnique: false,
    }
  }
  return cols
}

export interface SqlConsoleProps {
  connectionId: string
  /** Controlled SQL text. */
  value: string
  onChange: (sql: string) => void
  /** Slot rendered at the left of the toolbar (e.g. a status hint). */
  toolbarLeft?: ReactNode
  /** When set, shows a "Reset from no-code" button that re-seeds the editor. */
  onRegenerate?: () => void
}

/**
 * Monaco SQL editor over a results grid, with Run (Cmd/Ctrl+Enter). Shared by
 * the standalone Query tab and a table tab's Advanced mode (roadmap §5.1–5.2).
 */
export function SqlConsole({
  connectionId,
  value,
  onChange,
  toolbarLeft,
  onRegenerate,
}: SqlConsoleProps) {
  // Mirror the latest SQL into a ref so the Monaco keybinding (captured at
  // mount) always runs the current text, not the value at mount time.
  const valueRef = useRef(value)
  valueRef.current = value
  const theme = useEffectiveTheme()

  const mutation = useMutation({
    mutationFn: () => runQuery(connectionId, valueRef.current),
  })

  const columns = useMemo(
    () => (mutation.data ? buildColumnsFromResult(mutation.data) : {}),
    [mutation.data],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          {toolbarLeft ??
            (mutation.data
              ? `${mutation.data.rowCount ?? mutation.data.rows.length} rows · ${mutation.data.durationMs} ms`
              : 'Raw SQL · Cmd/Ctrl + Enter to run')}
        </div>
        <div className="flex items-center gap-2">
          {onRegenerate && (
            <Button size="sm" variant="outline" onClick={onRegenerate}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset from no-code
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Spinner aria-label="Running" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {mutation.isPending ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[40%_minmax(0,1fr)]">
        <div className="border-b border-border">
          <Suspense
            fallback={
              <Loading className="p-4 text-sm text-muted-foreground">
                Loading editor…
              </Loading>
            }
          >
            <MonacoEditor
              height="100%"
              language="sql"
              value={value}
              onChange={(v) => onChange(v ?? '')}
              theme={theme === 'dark' ? 'vs-dark' : 'vs'}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
              }}
              onMount={(editor, monaco) => {
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                  () => mutation.mutate(),
                )
              }}
            />
          </Suspense>
        </div>
        <div className="min-h-0 p-4">
          {mutation.error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {(mutation.error as Error).message}
            </div>
          )}
          {!mutation.error &&
            mutation.data &&
            (mutation.data.rows.length > 0 ? (
              <DataGrid
                rows={mutation.data.rows}
                columns={columns}
                sort={[]}
                onSortChange={() => {}}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                OK · {mutation.data.rowCount ?? 0} rows affected ·{' '}
                {mutation.data.durationMs} ms
              </p>
            ))}
          {!mutation.data && !mutation.error && (
            <p className="text-sm text-muted-foreground">
              Press Run (Cmd/Ctrl + Enter) to execute.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
