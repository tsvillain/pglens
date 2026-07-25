import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, Puzzle, RefreshCw, Search, Star, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/CopyButton'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Loading, Spinner } from '@/components/ui/spinner'
import { dropExtension, installExtension, listExtensions, type Extension } from '@/lib/api'
import { useConnectionStore } from '@/store/connection'

const installDdl = (name: string) => `CREATE EXTENSION IF NOT EXISTS "${name}";`
const dropDdl = (name: string) => `DROP EXTENSION IF EXISTS "${name}";`

export function Extensions() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const qc = useQueryClient()
  const [search, setSearch] = useState('')

  const exts = useQuery({
    queryKey: ['extensions', connectionId],
    queryFn: ({ signal }) => listExtensions(connectionId!, signal),
    enabled: !!connectionId,
    placeholderData: (prev) => prev,
  })

  const install = useMutation({
    mutationFn: (name: string) => installExtension(connectionId!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions', connectionId] }),
  })

  // Drop is destructive, so it goes through a confirm dialog (`pendingDrop`).
  const [pendingDrop, setPendingDrop] = useState<string | null>(null)
  const drop = useMutation({
    mutationFn: (name: string) => dropExtension(connectionId!, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions', connectionId] })
      setPendingDrop(null)
    },
  })

  // Popular first, then alphabetical (server already sorts by name).
  const filtered = useMemo(() => {
    const all = exts.data?.extensions ?? []
    const q = search.trim().toLowerCase()
    const matched = q
      ? all.filter((e) =>
          e.name.toLowerCase().includes(q) ||
          (e.comment?.toLowerCase().includes(q) ?? false))
      : all
    return [...matched].sort((a, b) => Number(b.popular) - Number(a.popular))
  }, [exts.data, search])

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">No active connection.</div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Extensions</h1>
          <p className="text-xs text-muted-foreground">
            Available Postgres extensions · one-click <code className="font-mono">CREATE EXTENSION</code>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => exts.refetch()}
          disabled={exts.isFetching}
          title="Refresh"
        >
          {exts.isFetching ? <Spinner aria-label="Refreshing" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {exts.isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loading>Loading extensions…</Loading>
          </div>
        )}

        {exts.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {(exts.error as Error).message}
          </div>
        )}

        {exts.data && (
          <div className="space-y-3">
            {!exts.data.superuser && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  You are not connected as a superuser. Installing most extensions will fail —
                  only trusted extensions (PG13+) can be created by non-superusers.
                </span>
              </div>
            )}

            {install.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
                {(install.error as Error).message}
              </div>
            )}

            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter extensions…"
                className="h-8 pl-7 text-sm"
              />
            </div>

            <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border bg-card">
              {filtered.length === 0 ? (
                <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No extensions match.
                </li>
              ) : (
                filtered.map((e) => (
                  <Row
                    key={e.name}
                    ext={e}
                    installing={install.isPending && install.variables === e.name}
                    onInstall={() => install.mutate(e.name)}
                    onUninstall={() => setPendingDrop(e.name)}
                  />
                ))
              )}
            </ul>
          </div>
        )}
      </div>

      <Dialog
        open={pendingDrop !== null}
        onClose={() => {
          if (drop.isPending) return
          setPendingDrop(null)
          drop.reset()
        }}
        title="Uninstall extension?"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setPendingDrop(null)} disabled={drop.isPending}>
              Keep
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => pendingDrop && drop.mutate(pendingDrop)}
              disabled={drop.isPending}
            >
              {drop.isPending && <Spinner aria-label="Uninstalling" />}
              Uninstall
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          This runs{' '}
          <code className="font-mono text-foreground">{pendingDrop && dropDdl(pendingDrop)}</code>.
          It fails if other objects depend on the extension (RESTRICT) — nothing is force-dropped.
        </p>
        {drop.error && <p className="mt-3 text-xs text-destructive">{(drop.error as Error).message}</p>}
      </Dialog>
    </div>
  )
}

function Row({
  ext, installing, onInstall, onUninstall,
}: {
  ext: Extension
  installing: boolean
  onInstall: () => void
  onUninstall: () => void
}) {
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <Puzzle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <code className="font-mono font-medium">{ext.name}</code>
          {ext.popular && (
            <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-label="Popular" />
          )}
          {ext.installed ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              installed v{ext.installedVersion}
              {ext.defaultVersion && ext.defaultVersion !== ext.installedVersion &&
                ` · v${ext.defaultVersion} available`}
            </span>
          ) : (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              v{ext.defaultVersion}
            </span>
          )}
        </div>
        {ext.comment && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={ext.comment}>
            {ext.comment}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {ext.installed ? (
          <>
            <CopyButton text={dropDdl(ext.name)} label="Copy SQL" />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-destructive hover:text-destructive"
              onClick={onUninstall}
              title={dropDdl(ext.name)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Uninstall
            </Button>
          </>
        ) : (
          <>
            <CopyButton text={installDdl(ext.name)} label="Copy SQL" />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={onInstall}
              disabled={installing}
              title={installDdl(ext.name)}
            >
              {installing ? <Spinner aria-label="Installing" /> : <Download className="h-3.5 w-3.5" />}
              Install
            </Button>
          </>
        )}
      </div>
    </li>
  )
}
