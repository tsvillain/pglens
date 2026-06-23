import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Eye, EyeOff, Plus, ServerCog } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loading } from '@/components/ui/spinner'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { listConnections } from '@/lib/api'
import { useConnectionStore } from '@/store/connection'
import { useTabsStore } from '@/store/tabs'

const HealthSchema = z.object({ ok: z.boolean(), version: z.string().optional() })

function maskHost(host?: string | null) {
  if (!host) return '—'
  return '•'.repeat(Math.min(host.length, 28))
}

async function fetchHealth() {
  const res = await fetch('/api/v3/health')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return HealthSchema.parse(await res.json())
}

export function Home() {
  const navigate = useNavigate()
  const setActive = useConnectionStore((s) => s.setActive)
  const openTab = useTabsStore((s) => s.open)

  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())

  const toggleHost = (id: string) =>
    setRevealed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false })
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => listConnections(signal).then((r) => r.connections),
  })

  const filtered = (connections.data ?? []).filter((c) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      c.name?.toLowerCase().includes(q) ||
      c.host?.toLowerCase().includes(q) ||
      c.database?.toLowerCase().includes(q)
    )
  })

  return (
    <div className="px-10 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="font-logo text-4xl leading-none tracking-wide">
              pglens
            </span>
            <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
              v{health.data?.version ?? '…'}
            </span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            No-code PostgreSQL workstation. Pick a connection below or add a
            new one to get started.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New connection
        </Button>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search connections by name, host, or database…"
          className="max-w-md"
        />
        <p className="text-xs text-muted-foreground">
          {connections.data
            ? `${filtered.length} of ${connections.data.length}`
            : ''}
        </p>
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connections.isLoading && (
          <li className="text-sm text-muted-foreground">
            <Loading>Loading connections…</Loading>
          </li>
        )}
        {connections.data?.length === 0 && (
          <li className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No saved connections yet. Click <kbd className="rounded border border-border bg-muted px-1">+</kbd> to add one.
          </li>
        )}
        {filtered.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => {
                setActive(c.id)
                openTab({ kind: 'schema' })
                navigate({ to: '/schema' })
              }}
              className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left shadow-sm hover:border-primary/40 hover:bg-accent/40"
            >
              <div className="flex items-center gap-2">
                <ServerCog className="h-4 w-4 text-primary" />
                <span className="truncate font-medium">{c.name}</span>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="shrink-0">host</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="min-w-0 truncate font-mono"
                      title={revealed.has(c.id) ? (c.host ?? undefined) : undefined}
                    >
                      {revealed.has(c.id) ? (c.host ?? '—') : maskHost(c.host)}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={revealed.has(c.id) ? 'Hide host' : 'Show host'}
                      className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleHost(c.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          toggleHost(c.id)
                        }
                      }}
                    >
                      {revealed.has(c.id) ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </span>
                  </span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="shrink-0">database</span>
                  <span className="min-w-0 truncate font-mono" title={c.database ?? undefined}>{c.database ?? '—'}</span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="shrink-0">schema</span>
                  <span className="min-w-0 truncate font-mono" title={c.schema ?? undefined}>{c.schema ?? 'public'}</span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="shrink-0">ssl</span>
                  <span className="min-w-0 truncate font-mono" title={c.sslMode ?? undefined}>{c.sslMode ?? 'prefer'}</span>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
