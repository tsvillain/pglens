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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Database, Gauge, Play, RotateCcw, Sparkles, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Loading, Spinner } from '@/components/ui/spinner'
import { QueryResults } from '@/components/QueryResults'
import { QueryHistoryMenu } from '@/components/QueryHistoryMenu'
import { SavedQueriesMenu } from '@/components/SavedQueriesMenu'
import {
  ApiError,
  addQueryHistory,
  commitTx,
  getDatabaseSchema,
  rollbackTx,
  runQuery,
  runTxQuery,
  type QueryResult,
  type TxQueryResult,
} from '@/lib/api'
import { registerSqlSupport, setActiveSchema } from '@/lib/sqlLanguage'
import { applyParams, extractParamNames } from '@/lib/sqlParams'
import { cn } from '@/lib/utils'
import { useEffectiveTheme } from '@/store/theme'
import { type TxMode, useTransactionStore } from '@/store/transaction'

const MonacoEditor = lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default })),
)

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
  const qc = useQueryClient()

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

  // When on, Run EXPLAINs the statement and shows the §6.3 plan visualizer
  // instead of the rows. `analyze` is the EXPLAIN ⇄ EXPLAIN ANALYZE toggle:
  // ANALYZE (default) runs the statement for real timings; plain EXPLAIN shows
  // estimates only and executes nothing (safe for writes / expensive queries).
  const [explain, setExplain] = useState(false)
  const [analyze, setAnalyze] = useState(true)

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
  const explainRef = useRef(explain)
  explainRef.current = explain
  const analyzeRef = useRef(analyze)
  analyzeRef.current = analyze

  // Record each run to per-connection query history (roadmap §5.5). Stores the
  // raw editor text (with any `:name` / `{{var}}` placeholders) so a restored
  // entry reproduces what the user typed, not a rewritten form. Fire-and-forget:
  // a history write failure never blocks the run.
  const recordHistory = useCallback(
    (success: boolean, data?: QueryResult | TxQueryResult, err?: unknown) => {
      const sql = valueRef.current
      if (!sql.trim()) return
      const rowCount = data
        ? data.results.reduce((n, r) => n + (r.rowCount ?? r.rows.length ?? 0), 0)
        : null
      addQueryHistory({
        connectionId,
        sql,
        durationMs: data?.durationMs ?? null,
        rowCount,
        success,
        error: success ? null : ((err as Error)?.message ?? 'Query failed').slice(0, 2000),
      })
        .then(() => qc.invalidateQueries({ queryKey: ['query-history', connectionId] }))
        .catch(() => {})
    },
    [connectionId, qc],
  )

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
      const opts = { explain: explainRef.current, analyze: analyzeRef.current }
      if (txModeRef.current === 'transaction') {
        // BEGIN runs implicitly on the first statement — mark the tab as holding
        // a transaction up front so the badge/buttons reflect it even if the
        // statement itself errors (the transaction stays open server-side).
        setTxOpen(tabId, connectionId)
        return runTxQuery(connectionId, tabId, text, params, opts)
      }
      return runQuery(connectionId, text, params, opts)
    },
    onSuccess: (data) => recordHistory(true, data),
    onError: (err) => {
      // Reserve/BEGIN never happened if the connection is gone — clear the
      // optimistic open flag. Other errors leave the transaction open to roll back.
      if (txModeRef.current === 'transaction' && (err as ApiError).code === 'NO_CONNECTION') {
        setTxClosed(tabId)
      }
      recordHistory(false, undefined, err)
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

  // Short run summary for the toolbar; QueryResults shows the per-result detail.
  const summary = mutation.data
    ? mutation.data.timing
      ? `${mutation.data.timing.executionMs != null ? 'EXPLAIN ANALYZE' : 'EXPLAIN'} · ${mutation.data.durationMs} ms`
      : `${mutation.data.results.length} result${mutation.data.results.length === 1 ? '' : 's'} · ${mutation.data.durationMs} ms`
    : null
  // Name exported result files after the table when this is a table tab's
  // Advanced mode, otherwise a generic name.
  const exportBase = tabId.startsWith('table:')
    ? tabId.slice('table:'.length)
    : 'query-result'

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
                summary ??
                'Raw SQL · Cmd/Ctrl + Enter to run · Cmd/Ctrl + S to format')}
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
          <SavedQueriesMenu
            connectionId={connectionId}
            currentSql={value}
            onLoad={onChange}
          />
          <QueryHistoryMenu connectionId={connectionId} onLoad={onChange} />
          <Button
            size="sm"
            variant={explain ? 'default' : 'outline'}
            aria-pressed={explain}
            onClick={() => setExplain((v) => !v)}
            title="EXPLAIN the statement and visualize the plan (roadmap §6.3)"
          >
            <Gauge className="h-3.5 w-3.5" /> Explain
          </Button>
          {explain && (
            <ExplainModeToggle analyze={analyze} onChange={setAnalyze} />
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
          {!mutation.error && mutation.data && (
            <QueryResults
              key={mutation.submittedAt}
              result={mutation.data}
              baseName={exportBase}
            />
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
 * `[ Plan | Analyze ]` segmented switch shown when Explain is on (roadmap §6.3).
 * "Plan" is a plain EXPLAIN — estimates only, the statement is not executed
 * (safe for writes / expensive queries). "Analyze" is EXPLAIN ANALYZE — actually
 * runs the statement for real timings.
 */
function ExplainModeToggle({
  analyze,
  onChange,
}: {
  analyze: boolean
  onChange: (analyze: boolean) => void
}) {
  const options: Array<{ value: boolean; label: string; title: string }> = [
    { value: false, label: 'Plan', title: 'Plain EXPLAIN — estimates only, nothing runs' },
    { value: true, label: 'Analyze', title: 'EXPLAIN ANALYZE — runs the statement for actual timings' },
  ]
  return (
    <div
      role="tablist"
      aria-label="Explain mode"
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs"
    >
      {options.map(({ value, label, title }) => {
        const active = analyze === value
        return (
          <button
            key={label}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(value)}
            title={title}
            className={cn(
              'rounded px-2 py-1 transition',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
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
