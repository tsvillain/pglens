import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Play, RotateCcw, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Loading, Spinner } from '@/components/ui/spinner'
import { DataGrid } from '@/components/DataGrid'
import {
  getDatabaseSchema,
  runQuery,
  type ColumnMeta,
  type QueryResult,
} from '@/lib/api'
import { registerSqlSupport, setActiveSchema } from '@/lib/sqlLanguage'
import { applyParams, extractParamNames } from '@/lib/sqlParams'
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
 * Monaco SQL editor over a results grid, with Run (Cmd/Ctrl+Enter), schema-aware
 * autocomplete, format-on-save (Cmd/Ctrl+S), and a `:name` parameter form
 * (roadmap §5.2). Shared by the standalone Query tab and a table tab's Advanced
 * mode (§5.1).
 */
export function SqlConsole({
  connectionId,
  value,
  onChange,
  toolbarLeft,
  onRegenerate,
}: SqlConsoleProps) {
  const theme = useEffectiveTheme()

  // Schema powers autocomplete; cached and shared with the no-code views via the
  // same query key. Kept in a ref so the editor's focus handler can publish it
  // to the (singleton) Monaco completion provider without re-running on mount.
  const schemaQuery = useQuery({
    queryKey: ['schema', connectionId],
    queryFn: ({ signal }) => getDatabaseSchema(connectionId, signal),
    staleTime: 60_000,
  })
  const schemaRef = useRef(schemaQuery.data?.schema ?? null)
  schemaRef.current = schemaQuery.data?.schema ?? null

  // Publish the schema to the (singleton) Monaco completion provider once it
  // loads — at mount the query is usually still pending, so without this the
  // provider would offer keywords but never tables/columns.
  useEffect(() => {
    setActiveSchema(schemaRef.current)
  }, [schemaQuery.data])

  // `:name` placeholders detected in the current SQL, and their bound values.
  const paramNames = useMemo(() => extractParamNames(value), [value])
  const [paramValues, setParamValues] = useState<Record<string, string>>({})

  // Mirror live values into refs so the mount-time Monaco keybindings always
  // read the current SQL/params, not the snapshot captured at mount.
  const valueRef = useRef(value)
  valueRef.current = value
  const paramValuesRef = useRef(paramValues)
  paramValuesRef.current = paramValues

  const mutation = useMutation({
    mutationFn: () => {
      const sql = valueRef.current
      const names = extractParamNames(sql)
      if (names.length > 0) {
        const { sql: text, params } = applyParams(sql, paramValuesRef.current)
        return runQuery(connectionId, text, params)
      }
      return runQuery(connectionId, sql)
    },
  })
  // Stable handle for the Monaco keybinding captured at mount.
  const runRef = useRef(() => mutation.mutate())
  runRef.current = () => mutation.mutate()
  // Set in onMount; invoked by the toolbar Format button. No-op until mounted.
  const formatRef = useRef<() => void>(() => {})

  const setParam = useCallback((name: string, val: string) => {
    setParamValues((prev) => ({ ...prev, [name]: val }))
  }, [])

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
              : 'Raw SQL · Cmd/Ctrl + Enter to run · Cmd/Ctrl + S to format')}
        </div>
        <div className="flex items-center gap-2">
          {onRegenerate && (
            <Button size="sm" variant="outline" onClick={onRegenerate}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset from no-code
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => formatRef.current()}
            title="Format SQL (Cmd/Ctrl + S)"
          >
            <Sparkles className="h-3.5 w-3.5" /> Format
          </Button>
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

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,40%)_auto_minmax(0,1fr)]">
        <div className="min-h-0 border-b border-border">
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
                automaticLayout: true,
                tabSize: 2,
                multiCursorModifier: 'ctrlCmd',
                suggestOnTriggerCharacters: true,
                quickSuggestions: { other: true, comments: false, strings: false },
              }}
              beforeMount={(monaco) => registerSqlSupport(monaco)}
              onMount={(editor, monaco) => {
                setActiveSchema(schemaRef.current)
                editor.onDidFocusEditorText(() => setActiveSchema(schemaRef.current))
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                  () => runRef.current(),
                )
                // Cmd/Ctrl+S formats (and swallows the browser save dialog).
                const format = () =>
                  editor.getAction('editor.action.formatDocument')?.run()
                formatRef.current = format
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                  () => format(),
                )
              }}
            />
          </Suspense>
        </div>

        {paramNames.length > 0 ? (
          <ParamForm
            names={paramNames}
            values={paramValues}
            onChange={setParam}
          />
        ) : (
          <div />
        )}

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

/**
 * Inputs for each `:name` placeholder, shown below the editor. Values are bound
 * positionally on run, so blanks send SQL NULL.
 */
function ParamForm({
  names,
  values,
  onChange,
}: {
  names: string[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/30 px-4 py-2">
      <span className="text-xs font-medium text-muted-foreground">Parameters</span>
      {names.map((name) => (
        <label key={name} className="flex flex-col gap-0.5 text-xs">
          <span className="font-mono text-muted-foreground">:{name}</span>
          <input
            value={values[name] ?? ''}
            onChange={(e) => onChange(name, e.target.value)}
            placeholder="NULL"
            className="h-7 w-40 rounded border border-border bg-background px-2 text-sm outline-none focus:border-ring"
          />
        </label>
      ))}
    </div>
  )
}
