import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Loading, Spinner } from '@/components/ui/spinner'
import { DataGrid } from '@/components/DataGrid'
import { runQuery, type QueryResult, type ColumnMeta } from '@/lib/api'
import { useConnectionStore } from '@/store/connection'

const MonacoEditor = lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default })),
)

const DEFAULT_SQL = `-- Advanced mode. Raw SQL escape hatch.
-- Press Cmd/Ctrl + Enter to run.

SELECT now();`

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

export function QueryRunner() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const [sql, setSql] = useState(DEFAULT_SQL)
  const sqlRef = useRef(sql)
  sqlRef.current = sql

  const mutation = useMutation({
    mutationFn: () => runQuery(connectionId!, sqlRef.current),
  })

  const columns = useMemo(
    () => (mutation.data ? buildColumnsFromResult(mutation.data) : {}),
    [mutation.data],
  )

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Query</h1>
          <p className="text-xs text-muted-foreground">
            {mutation.data
              ? `${mutation.data.rowCount ?? mutation.data.rows.length} rows · ${mutation.data.durationMs} ms`
              : 'Advanced mode (raw SQL)'}
          </p>
        </div>
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? (
            <Spinner aria-label="Running" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {mutation.isPending ? 'Running query…' : 'Run'}
        </Button>
      </header>

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
              value={sql}
              onChange={(v) => setSql(v ?? '')}
              theme="vs-dark"
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
          {!mutation.error && mutation.data && (
            mutation.data.rows.length > 0 ? (
              <DataGrid
                rows={mutation.data.rows}
                columns={columns}
                sort={null}
                onSortChange={() => {}}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                OK · {mutation.data.rowCount ?? 0} rows affected ·{' '}
                {mutation.data.durationMs} ms
              </p>
            )
          )}
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
