import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { cn } from '@/lib/utils'

const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
})

async function fetchHealth() {
  const res = await fetch('/api/v3/health')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return HealthSchema.parse(await res.json())
}

export function Home() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
  })

  return (
    <div className="px-10 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">pglens v3</h1>
        <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          preview
        </span>
      </div>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Phase 0 foundation. Vite + React 18 + TypeScript strict. shadcn/ui +
        Tailwind. TanStack Query + Router + Table. Served at <code>/v3</code>
        {' '}behind a feature flag while the v2 client at <code>/</code> stays
        authoritative.
      </p>

      <section className="mt-10 max-w-xl rounded-lg border border-border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-medium">Backend handshake</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sanity check that the v3 mount can reach the API.
        </p>
        <div className="mt-4 text-sm">
          {isLoading && <span className="text-muted-foreground">Pinging…</span>}
          {error && (
            <span className="text-destructive">{(error as Error).message}</span>
          )}
          {data && (
            <span
              className={cn(
                'inline-flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1',
              )}
            >
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              ok={String(data.ok)}
              {data.version ? ` · v${data.version}` : ''}
            </span>
          )}
        </div>
      </section>

      <ul className="mt-10 grid max-w-2xl gap-3 text-sm text-muted-foreground sm:grid-cols-2">
        <li className="rounded-md border border-border p-3">✓ Landing</li>
        <li className="rounded-md border border-border p-3">✓ Sidebar</li>
        <li className="rounded-md border border-border p-3">… Table viewer</li>
        <li className="rounded-md border border-border p-3">… Schema viz</li>
        <li className="rounded-md border border-border p-3">… Connection dialog</li>
        <li className="rounded-md border border-border p-3">… Query runner</li>
      </ul>
    </div>
  )
}
