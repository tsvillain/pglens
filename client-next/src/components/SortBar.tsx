import { useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import type { ColumnMeta, SortEntry } from '@/lib/api'
import { cn } from '@/lib/utils'

interface SortBarProps {
  columns: Record<string, ColumnMeta>
  sort: SortEntry[]
  onChange: (next: SortEntry[]) => void
}

const MAX_SORTS = 10

export function SortBar({ columns, sort, onChange }: SortBarProps) {
  const [showSql, setShowSql] = useState(false)
  const columnNames = useMemo(() => Object.keys(columns), [columns])

  // Names not yet in the sort list — used to populate the "+ Add sort" picker.
  const available = columnNames.filter((n) => !sort.some((s) => s.column === n))

  if (columnNames.length === 0) return null

  function update(index: number, patch: Partial<SortEntry>) {
    onChange(sort.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  function remove(index: number) {
    onChange(sort.filter((_, i) => i !== index))
  }

  function add(column: string) {
    if (!column) return
    onChange([...sort, { column, direction: 'asc' }])
  }

  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= sort.length || to >= sort.length) return
    const next = [...sort]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  function clearAll() {
    onChange([])
  }

  const sqlPreview = previewOrderBy(sort)

  return (
    <div className="border-b border-border bg-muted/20 px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sort
        </span>

        {sort.length === 0 ? (
          <span className="text-xs text-muted-foreground">No sort</span>
        ) : (
          sort.map((entry, i) => (
            <SortChip
              key={`${entry.column}-${i}`}
              entry={entry}
              index={i}
              showPriority={sort.length > 1}
              onDirectionChange={(direction) => update(i, { direction })}
              onRemove={() => remove(i)}
              onReorder={reorder}
            />
          ))
        )}

        {available.length > 0 && sort.length < MAX_SORTS && (
          <AddSortPicker columns={available} onAdd={add} />
        )}

        {sort.length > 0 && (
          <Button size="sm" variant="ghost" onClick={clearAll}>
            Clear
          </Button>
        )}

        {sort.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showSql ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Show SQL
          </button>
        )}
      </div>

      {showSql && sqlPreview && (
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
          {sqlPreview}
        </pre>
      )}
    </div>
  )
}

interface SortChipProps {
  entry: SortEntry
  index: number
  showPriority: boolean
  onDirectionChange: (d: 'asc' | 'desc') => void
  onRemove: () => void
  onReorder: (from: number, to: number) => void
}

function SortChip({
  entry, index, showPriority, onDirectionChange, onRemove, onReorder,
}: SortChipProps) {
  const [dragOver, setDragOver] = useState(false)
  const dragRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={dragRef}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(index))
      }}
      onDragOver={(e) => {
        // Must preventDefault so the drop event fires; data is set by the
        // dragged chip, so we don't read it during dragover.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const from = Number(e.dataTransfer.getData('text/plain'))
        if (!Number.isNaN(from)) onReorder(from, index)
      }}
      className={cn(
        'inline-flex items-stretch overflow-hidden rounded-md border bg-background transition-shadow',
        dragOver ? 'border-primary ring-2 ring-primary/30' : 'border-border',
      )}
      aria-label={`Sort ${index + 1}: ${entry.column} ${entry.direction}`}
    >
      <span
        className="flex cursor-grab items-center px-1.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
        title="Drag to reorder priority"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>

      {showPriority && (
        <span className="flex items-center bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
          {index + 1}
        </span>
      )}

      <span className="flex items-center px-2 text-xs font-medium">
        {entry.column}
      </span>

      <button
        type="button"
        onClick={() =>
          onDirectionChange(entry.direction === 'asc' ? 'desc' : 'asc')
        }
        title={`Direction: ${entry.direction.toUpperCase()} (click to toggle)`}
        className="flex items-center gap-1 border-l border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {entry.direction === 'asc' ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )}
        <span className="uppercase">{entry.direction}</span>
      </button>

      <button
        type="button"
        onClick={onRemove}
        className="flex items-center border-l border-border px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label="Remove sort"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function AddSortPicker({
  columns, onAdd,
}: { columns: string[]; onAdd: (name: string) => void }) {
  // A Select that resets after each pick — uses an empty placeholder option
  // so the same column can be added later if removed.
  const [value, setValue] = useState('')
  return (
    <div className="inline-flex items-center gap-1">
      <Select
        value={value}
        onChange={(e) => {
          const v = e.target.value
          if (v) {
            onAdd(v)
            setValue('')
          }
        }}
        className="h-8 w-44"
        aria-label="Add sort column"
      >
        <option value="">+ Add sort…</option>
        {columns.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
      <Plus className="h-3.5 w-3.5 text-muted-foreground" />
    </div>
  )
}

/**
 * Render the sort spec as a human-readable ORDER BY clause. Display-only;
 * the server quotes identifiers itself when building the actual query.
 */
function previewOrderBy(sort: SortEntry[]): string {
  if (sort.length === 0) return ''
  return (
    'ORDER BY ' +
    sort
      .map((s) => `"${s.column.replaceAll('"', '""')}" ${s.direction.toUpperCase()}`)
      .join(', ')
  )
}
