import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle, ArrowRight, Download, GitCompare,
  Minus, Pencil, Play, Plus, RefreshCw,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/CopyButton'
import { Select } from '@/components/ui/select'
import { Loading, Spinner } from '@/components/ui/spinner'
import {
  getSchemaDiff, listConnections,
  type Connection, type Migration, type SchemaDiffResponse, type TableChange,
} from '@/lib/api'
import { downloadBlob } from '@/lib/download'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/store/connection'
import { useQuerySeedStore } from '@/store/querySeed'
import { useTabsStore } from '@/store/tabs'

export function SchemaDiff() {
  const activeId = useConnectionStore((s) => s.activeConnectionId)

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => listConnections(signal).then((r) => r.connections),
  })
  const conns = connections.data ?? []

  const [source, setSource] = useState<string>('')
  const [target, setTarget] = useState<string>('')

  // Default source → active connection, target → first other connection.
  const resolvedSource = source || activeId || conns[0]?.id || ''
  const resolvedTarget =
    target || conns.find((c) => c.id !== resolvedSource)?.id || ''

  const ready = !!resolvedSource && !!resolvedTarget && resolvedSource !== resolvedTarget

  const diff = useQuery({
    queryKey: ['schema-diff', resolvedSource, resolvedTarget],
    queryFn: ({ signal }) => getSchemaDiff(resolvedSource, resolvedTarget, signal),
    enabled: ready,
    placeholderData: (prev) => prev,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Schema diff &amp; migration</h1>
          <p className="text-xs text-muted-foreground">
            Compare two connections · generated SQL is never run for you
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => diff.refetch()}
          disabled={!ready || diff.isFetching}
          title="Re-compare"
        >
          {diff.isFetching ? <Spinner aria-label="Comparing" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Re-compare
        </Button>
      </header>

      {/* Connection pickers */}
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-6 py-3">
        <ConnPicker label="Source (current)" value={resolvedSource} conns={conns} onChange={setSource} />
        <ArrowRight className="mb-2 h-4 w-4 text-muted-foreground" />
        <ConnPicker label="Target (desired)" value={resolvedTarget} conns={conns} onChange={setTarget} />
        <p className="mb-2 ml-2 text-[11px] text-muted-foreground">
          Forward migration makes <strong>source</strong> match <strong>target</strong>.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {conns.length < 2 && (
          <Empty>Add at least two connections to diff their schemas.</Empty>
        )}
        {ready && diff.isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loading>Comparing schemas…</Loading>
          </div>
        )}
        {diff.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {(diff.error as Error).message}
          </div>
        )}
        {diff.data && <DiffResult data={diff.data} />}
      </div>
    </div>
  )
}

function ConnPicker({
  label, value, conns, onChange,
}: {
  label: string
  value: string
  conns: Connection[]
  onChange: (id: string) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-56">
        {conns.map((c) => (
          <option key={c.id} value={c.id}>
            {(c.name || c.id)} · {c.schema ?? 'public'}
          </option>
        ))}
      </Select>
    </label>
  )
}

function DiffResult({ data }: { data: SchemaDiffResponse }) {
  const { diff } = data
  const noChanges =
    diff.tables.added.length === 0 &&
    diff.tables.dropped.length === 0 &&
    diff.changed.length === 0

  if (noChanges) {
    return <Empty>Schemas are identical. 🎉</Empty>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Stat tone="add" label="tables added" n={diff.tables.added.length} />
        <Stat tone="drop" label="tables dropped" n={diff.tables.dropped.length} />
        <Stat tone="change" label="tables changed" n={diff.changed.length} />
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <DiffPanel data={data} />
        <MigrationPanel data={data} />
      </section>
    </div>
  )
}

// ---- Diff panel -------------------------------------------------------------

function DiffPanel({ data }: { data: SchemaDiffResponse }) {
  const { diff } = data
  return (
    <Panel title="Changes" icon={GitCompare}>
      <div className="space-y-1 px-4 py-3 text-sm">
        {diff.tables.added.map((t) => (
          <Line key={`a-${t}`} tone="add" icon={Plus}>
            <code className="font-mono">{t}</code> <span className="text-muted-foreground">(new table)</span>
          </Line>
        ))}
        {diff.tables.dropped.map((t) => (
          <Line key={`d-${t}`} tone="drop" icon={Minus}>
            <code className="font-mono">{t}</code> <span className="text-muted-foreground">(dropped table)</span>
          </Line>
        ))}
        {diff.changed.map((ch) => (
          <TableChangeBlock key={ch.table} ch={ch} />
        ))}
      </div>
    </Panel>
  )
}

function TableChangeBlock({ ch }: { ch: TableChange }) {
  return (
    <div className="mt-2 border-l-2 border-amber-400/50 pl-3">
      <div className="flex items-center gap-2">
        <Pencil className="h-3.5 w-3.5 text-amber-500" />
        <code className="font-mono text-sm">{ch.table}</code>
      </div>
      <ul className="mt-1 space-y-0.5 pl-5 text-xs">
        {ch.columns.added.map((c) => (
          <Sub key={`ca-${c.name}`} tone="add">+ column {c.name} {c.type}</Sub>
        ))}
        {ch.columns.changed.map((c) => (
          <Sub key={`cc-${c.name}`} tone="change">
            ~ column {c.name}: {c.from.type} → {c.to.type}
            {c.from.notNull !== c.to.notNull && (c.to.notNull ? ' · SET NOT NULL' : ' · DROP NOT NULL')}
          </Sub>
        ))}
        {ch.columns.dropped.map((c) => (
          <Sub key={`cd-${c.name}`} tone="drop">− column {c.name}</Sub>
        ))}
        {ch.constraints.added.map((c) => <Sub key={`xa-${c.name}`} tone="add">+ constraint {c.name}</Sub>)}
        {ch.constraints.changed.map((c) => <Sub key={`xc-${c.name}`} tone="change">~ constraint {c.name}</Sub>)}
        {ch.constraints.dropped.map((c) => <Sub key={`xd-${c.name}`} tone="drop">− constraint {c.name}</Sub>)}
        {ch.indexes.added.map((c) => <Sub key={`ia-${c.name}`} tone="add">+ index {c.name}</Sub>)}
        {ch.indexes.changed.map((c) => <Sub key={`ic-${c.name}`} tone="change">~ index {c.name}</Sub>)}
        {ch.indexes.dropped.map((c) => <Sub key={`id-${c.name}`} tone="drop">− index {c.name}</Sub>)}
      </ul>
    </div>
  )
}

// ---- Migration panel --------------------------------------------------------

function MigrationPanel({ data }: { data: SchemaDiffResponse }) {
  const [dir, setDir] = useState<'forward' | 'backward'>('forward')
  const migration: Migration = dir === 'forward' ? data.forward : data.backward
  // The migration runs against the side it transforms: forward → source, backward → target.
  const runAgainst = dir === 'forward' ? data.source : data.target

  const script = useMemo(
    () => migration.statements.map((s) => s.sql).join('\n'),
    [migration],
  )

  const navigate = useNavigate()
  const openTab = useTabsStore((s) => s.open)
  const setActive = useConnectionStore((s) => s.setActive)
  const openInEditor = () => {
    // Switch the editor to the connection this migration is meant to run against,
    // seed the SQL, and jump there — the user reviews and runs it.
    setActive(runAgainst.connectionId)
    useQuerySeedStore.getState().setSeed(script)
    openTab({ kind: 'query' })
    navigate({ to: '/query' })
  }

  const download = () => downloadBlob(script, `migration_${dir}.sql`, 'application/sql')

  return (
    <Panel
      title="Migration"
      icon={Play}
      action={
        <div className="flex rounded-md border border-border p-0.5">
          {(['forward', 'backward'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDir(d)}
              className={cn(
                'rounded px-2 py-0.5 text-xs',
                dir === d ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
              )}
            >
              {d === 'forward' ? 'Forward' : 'Backward'}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>
            runs against <code className="font-mono">{runAgainst.connectionId.slice(0, 8)}</code> · {runAgainst.schema}
          </span>
          <div className="flex items-center gap-1">
            <CopyButton text={script} />
            <Button size="sm" variant="ghost" className="h-7" onClick={download} disabled={!script}>
              <Download className="h-3.5 w-3.5" />Download
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={openInEditor} disabled={!script}>
              <Play className="h-3.5 w-3.5" />Open in editor
            </Button>
          </div>
        </div>

        {migration.hasDestructive && (
          <div className="flex items-start gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Contains destructive operations (highlighted) — review before running.</span>
          </div>
        )}

        {migration.statements.length === 0 ? (
          <Empty>No statements for this direction.</Empty>
        ) : (
          <pre className="max-h-[28rem] overflow-auto px-4 py-3 text-xs leading-relaxed">
            {migration.statements.map((s, i) => (
              <div
                key={i}
                className={cn('whitespace-pre-wrap font-mono', s.destructive && 'text-destructive')}
                title={s.destructive ? 'destructive operation' : undefined}
              >
                {s.sql}
              </div>
            ))}
          </pre>
        )}
      </div>
    </Panel>
  )
}

// ---- Small shared bits ------------------------------------------------------

function Panel({
  title, icon: Icon, action, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}

const TONE: Record<string, string> = {
  add: 'text-emerald-600 dark:text-emerald-400',
  drop: 'text-destructive',
  change: 'text-amber-600 dark:text-amber-400',
}

function Stat({ tone, label, n }: { tone: keyof typeof TONE; label: string; n: number }) {
  return (
    <span className="rounded-md border border-border bg-card px-2 py-1">
      <span className={cn('font-semibold tabular-nums', TONE[tone])}>{n}</span>{' '}
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function Line({
  tone, icon: Icon, children,
}: {
  tone: keyof typeof TONE
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={cn('h-3.5 w-3.5 shrink-0', TONE[tone])} />
      <span>{children}</span>
    </div>
  )
}

function Sub({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <li className={cn('font-mono', TONE[tone])}>{children}</li>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</p>
}
