import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/** True for values that benefit from the collapsible tree (objects/arrays). */
export function isExpandable(value: unknown): boolean {
  return value !== null && typeof value === 'object'
}

/**
 * Coerce a raw cell value into a JS value for the tree. jsonb arrives parsed
 * from the driver, but json/text columns may hand us a JSON string.
 */
export function coerceJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground/60 italic">null</span>
  switch (typeof value) {
    case 'string':
      return <span className="text-emerald-600 dark:text-emerald-400">"{value}"</span>
    case 'number':
      return <span className="text-sky-600 dark:text-sky-400">{value}</span>
    case 'boolean':
      return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>
    default:
      return <span>{String(value)}</span>
  }
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2)

  if (!isExpandable(value)) {
    return (
      <div className="flex gap-1.5 leading-relaxed">
        {name !== undefined && <span className="text-foreground/80">{name}:</span>}
        <Leaf value={value} />
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)
  const open_b = isArray ? '[' : '{'
  const close_b = isArray ? ']' : '}'

  return (
    <div className="leading-relaxed">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {name !== undefined && <span className="text-foreground/80">{name}:</span>}
        <span className="text-muted-foreground">
          {open_b}
          {!open && (
            <span className="px-1 text-muted-foreground/60">
              {entries.length} {entries.length === 1 ? 'item' : 'items'}
            </span>
          )}
          {!open && close_b}
        </span>
      </button>
      {open && (
        <div className="ml-3 border-l border-border/60 pl-3">
          {entries.map(([k, v]) => (
            <Node key={k} name={isArray ? undefined : k} value={v} depth={depth + 1} />
          ))}
          <span className="text-muted-foreground">{close_b}</span>
        </div>
      )}
    </div>
  )
}

export function JsonViewer({ value, className }: { value: unknown; className?: string }) {
  const [copied, setCopied] = useState(false)
  const data = coerceJson(value)

  function copy() {
    void navigator.clipboard
      .writeText(JSON.stringify(data, null, 2))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
  }

  return (
    <div className={cn('relative', className)}>
      <button
        onClick={copy}
        className="absolute right-0 top-0 flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="overflow-auto pr-16 font-mono text-xs">
        <Node value={data} depth={0} />
      </div>
    </div>
  )
}
