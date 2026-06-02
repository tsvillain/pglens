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
import { Check, Database, Play, RotateCcw, Sparkles, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Loading, Spinner } from '@/components/ui/spinner'
import { DataGrid } from '@/components/DataGrid'
import {
  ApiError,
  commitTx,
  getDatabaseSchema,
  rollbackTx,
  runQuery,
  runTxQuery,
  type ColumnMeta,
  type QueryResult,
} from '@/lib/api'
import { registerSqlSupport, setActiveSchema } from '@/lib/sqlLanguage'
import { applyParams, extractParamNames } from '@/lib/sqlParams'
import { cn } from '@/lib/utils'
import { useEffectiveTheme } from '@/store/theme'
import { type TxMode, useTransactionStore } from '@/store/transaction'

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
  /** Tab id — keys the per-tab transaction session (roadmap §5.3). */
  tabId: string
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
  tabId,
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

  // Per-tab transaction state (roadmap §5.3). `txMode` is the Auto-commit ⇄
  // Transaction toggle; `txOpen` tracks whether a transaction is currently open
  // (drives Commit/Rollback enablement and the tab's "T" badge).
  const txMode = useTransactionStore((s) => s.mode[tabId] ?? 'autocommit')
  const txOpen = useTransactionStore((s) => s.open[tabId] ?? false)
  const setTxMode = useTransactionStore((s) => s.setMode)
  const setTxOpen = useTransactionStore((s) => s.setOpen)
  const setTxClosed = useTransactionStore((s) => s.setClosed)

  // Mirror live values into refs so the mount-time Monaco keybindings always
  // read the current SQL/params/mode, not the snapshot captured at mount.
  const valueRef = useRef(value)
  valueRef.current = value
  const paramValuesRef = useRef(paramValues)
  paramValuesRef.current = paramValues
  const txModeRef = useRef(txMode)
  txModeRef.current = txMode

  const mutation = useMutation({
    mutationFn: () => {
      const sql = valueRef.current
      const names = extractParamNames(sql)
      const [text, params] =
        names.length > 0
          ? (() => {
              const applied = applyParams(sql, paramValuesRef.current)
              return [applied.sql, applied.params] as const
            })()
          : ([sql, undefined] as const)
      if (txModeRef.current === 'transaction') {
        // BEGIN runs implicitly on the first statement — mark the tab as holding
        // a transaction up front so the badge/buttons reflect it even if the
        // statement itself errors (the transaction stays open server-side).
        setTxOpen(tabId, connectionId)
        return runTxQuery(connectionId, tabId, text, params)
      }
      return runQuery(connectionId, text, params)
    },
    onError: (err) => {
      // Reserve/BEGIN never happened if the connection is gone — clear the
      // optimistic open flag. Other errors leave the transaction open to roll back.
      if (txModeRef.current === 'transaction' && (err as ApiError).code === 'NO_CONNECTION') {
        setTxClosed(tabId)
      }
    },
  })

  const commitMutation = useMutation({
    mutationFn: () => commitTx(connectionId, tabId),
    onSuccess: () => setTxClosed(tabId),
  })
  const rollbackMutation = useMutation({
    mutationFn: () => rollbackTx(connectionId, tabId),
    onSuccess: () => setTxClosed(tabId),
  })
  const txControlPending = commitMutation.isPending || rollbackMutation.isPending
  const txControlError =
    (commitMutation.error as Error | null) ?? (rollbackMutation.error as Error | null)

  // Flip the Auto-commit ⇄ Transaction toggle. Switching back to Auto-commit is
  // blocked while a transaction is open — the user must Commit or Rollback first
  // so a held backend is never silently stranded.
  const switchTxMode = (next: TxMode) => {
    if (next === 'autocommit' && txOpen) return
    setTxMode(tabId, next)
  }
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
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {txOpen && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400"
              title="An uncommitted transaction is open on this tab"
            >
              <Database className="h-3 w-3" /> Transaction open
            </span>
          )}
          <span className="truncate">
            {txControlError
              ? txControlError.message
              : (toolbarLeft ??
                (mutation.data
                  ? `${mutation.data.rowCount ?? mutation.data.rows.length} rows · ${mutation.data.durationMs} ms`
                  : 'Raw SQL · Cmd/Ctrl + Enter to run · Cmd/Ctrl + S to format'))}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TxToggle mode={txMode} txOpen={txOpen} onChange={switchTxMode} />
          {txMode === 'transaction' && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => commitMutation.mutate()}
                disabled={!txOpen || txControlPending || mutation.isPending}
                title="COMMIT the open transaction"
              >
                {commitMutation.isPending ? (
                  <Spinner aria-label="Committing" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Commit
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => rollbackMutation.mutate()}
                disabled={!txOpen || txControlPending || mutation.isPending}
                title="ROLLBACK the open transaction"
              >
                {rollbackMutation.isPending ? (
                  <Spinner aria-label="Rolling back" />
                ) : (
                  <Undo2 className="h-3.5 w-3.5" />
                )}
                Rollback
              </Button>
            </>
          )}
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
 * `[ Auto-commit | Transaction ]` segmented switch (roadmap §5.3). Switching
 * back to Auto-commit is disabled while a transaction is open so the user can't
 * strand a held backend — they must Commit or Rollback first.
 */
function TxToggle({
  mode,
  txOpen,
  onChange,
}: {
  mode: TxMode
  txOpen: boolean
  onChange: (mode: TxMode) => void
}) {
  const options: Array<{ value: TxMode; label: string }> = [
    { value: 'autocommit', label: 'Auto-commit' },
    { value: 'transaction', label: 'Transaction' },
  ]
  return (
    <div
      role="tablist"
      aria-label="Transaction mode"
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs"
    >
      {options.map(({ value, label }) => {
        const active = mode === value
        const blocked = value === 'autocommit' && txOpen && mode !== 'autocommit'
        return (
          <button
            key={value}
            role="tab"
            aria-selected={active}
            disabled={blocked}
            onClick={() => onChange(value)}
            title={blocked ? 'Commit or roll back the open transaction first' : undefined}
            className={cn(
              'rounded px-2.5 py-1 transition',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              blocked && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
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
