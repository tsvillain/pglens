import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { listTables } from '@/lib/api'
import { useConnectionStore } from '@/store/connection'
import { cn } from '@/lib/utils'

export function Spotlight() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const connectionId = useConnectionStore((s) => s.activeConnectionId)

  // Cmd/Ctrl + K toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  const tablesQuery = useQuery({
    queryKey: ['tables', connectionId],
    queryFn: ({ signal }) => listTables(connectionId!, signal).then((r) => r.tables),
    enabled: !!connectionId && open,
  })

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = tablesQuery.data ?? []
    if (!q) return all.slice(0, 20)
    return all.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 20)
  }, [tablesQuery.data, query])

  if (!open) return null

  const onPick = (index: number) => {
    const t = results[index]
    if (!t) return
    setOpen(false)
    navigate({ to: '/tables/$tableName', params: { tableName: t.name } })
  }

  return createPortal(
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm pt-[12vh]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIndex((i) => Math.min(results.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                onPick(activeIndex)
              }
            }}
            placeholder="Search tables…"
            className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </div>
        <ul className="max-h-[40vh] overflow-y-auto py-1">
          {!connectionId && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Pick a connection in the sidebar.
            </li>
          )}
          {tablesQuery.isLoading && (
            <li className="px-3 py-2 text-xs text-muted-foreground">Loading tables…</li>
          )}
          {connectionId && !tablesQuery.isLoading && results.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">No matches</li>
          )}
          {results.map((t, i) => (
            <li key={t.name}>
              <button
                onClick={() => onPick(i)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
                  i === activeIndex && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="truncate font-mono text-xs">{t.name}</span>
                <span className="text-[10px] uppercase text-muted-foreground">
                  {t.type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
