import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { ColumnMeta, FilterCondition, FilterGroup, FilterOp } from '@/lib/api'
import {
  OPERATOR_LABELS,
  opNeedsValue,
  opTakesArray,
  operatorsForType,
  previewWhere,
} from '@/lib/filterSql'
import { cn } from '@/lib/utils'

interface FilterBarProps {
  columns: Record<string, ColumnMeta>
  filter: FilterGroup
  onChange: (next: FilterGroup) => void
}

export const EMPTY_FILTER: FilterGroup = { type: 'group', combinator: 'and', children: [] }

export function FilterBar({ columns, filter, onChange }: FilterBarProps) {
  const [showSql, setShowSql] = useState(false)
  const columnNames = useMemo(() => Object.keys(columns), [columns])

  if (columnNames.length === 0) return null

  const conditions = filter.children.filter(
    (c): c is FilterCondition => c.type === 'condition',
  )

  function updateCondition(index: number, patch: Partial<FilterCondition>) {
    const next: FilterGroup = {
      ...filter,
      children: filter.children.map((c, i) =>
        i === index && c.type === 'condition' ? { ...c, ...patch } : c,
      ),
    }
    onChange(next)
  }

  function removeCondition(index: number) {
    onChange({ ...filter, children: filter.children.filter((_, i) => i !== index) })
  }

  function addCondition() {
    const firstCol = columnNames[0]
    const ops = operatorsForType(columns[firstCol]?.dataType)
    const op = ops[0] ?? 'eq'
    const next: FilterCondition = {
      type: 'condition',
      column: firstCol,
      op,
      ...(opNeedsValue(op) ? { value: '' } : {}),
    }
    onChange({ ...filter, children: [...filter.children, next] })
  }

  function setCombinator(combinator: 'and' | 'or') {
    onChange({ ...filter, combinator })
  }

  function clearAll() {
    onChange(EMPTY_FILTER)
  }

  const sqlPreview = previewWhere(filter)

  return (
    <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {conditions.length === 0 ? (
          <span className="text-xs text-muted-foreground">No filters</span>
        ) : (
          <ConjunctionToggle combinator={filter.combinator} onChange={setCombinator} />
        )}

        {conditions.map((c, i) => (
          <ConditionRow
            key={i}
            condition={c}
            columns={columns}
            columnNames={columnNames}
            showCombinator={i > 0}
            combinator={filter.combinator}
            onChange={(patch) => updateCondition(i, patch)}
            onRemove={() => removeCondition(i)}
          />
        ))}

        <Button size="sm" variant="outline" onClick={addCondition}>
          <Plus className="h-3.5 w-3.5" /> Add filter
        </Button>

        {conditions.length > 0 && (
          <Button size="sm" variant="ghost" onClick={clearAll}>
            Clear
          </Button>
        )}

        {conditions.length > 0 && (
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

function ConjunctionToggle({
  combinator, onChange,
}: { combinator: 'and' | 'or'; onChange: (c: 'and' | 'or') => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-background text-xs">
      {(['and', 'or'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            'px-2 py-1 uppercase',
            combinator === c
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {c}
        </button>
      ))}
    </div>
  )
}

interface ConditionRowProps {
  condition: FilterCondition
  columns: Record<string, ColumnMeta>
  columnNames: string[]
  showCombinator: boolean
  combinator: 'and' | 'or'
  onChange: (patch: Partial<FilterCondition>) => void
  onRemove: () => void
}

function ConditionRow({
  condition, columns, columnNames, showCombinator, combinator, onChange, onRemove,
}: ConditionRowProps) {
  const meta = columns[condition.column]
  const ops = useMemo(() => operatorsForType(meta?.dataType), [meta?.dataType])

  function onColumnChange(name: string) {
    const newOps = operatorsForType(columns[name]?.dataType)
    const op = newOps.includes(condition.op) ? condition.op : (newOps[0] ?? 'eq')
    onChange({
      column: name,
      op,
      ...(opNeedsValue(op) ? { value: condition.value ?? '' } : { value: undefined }),
    })
  }

  function onOpChange(op: FilterOp) {
    onChange({
      op,
      ...(opNeedsValue(op) ? { value: condition.value ?? '' } : { value: undefined }),
    })
  }

  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-border bg-background">
      {showCombinator && (
        <span className="flex items-center px-2 text-[10px] font-semibold uppercase text-muted-foreground">
          {combinator}
        </span>
      )}

      <Select
        value={condition.column}
        onChange={(e) => onColumnChange(e.target.value)}
        className="w-40 border-0 border-r border-border"
        aria-label="Filter column"
      >
        {columnNames.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </Select>

      <Select
        value={condition.op}
        onChange={(e) => onOpChange(e.target.value as FilterOp)}
        className="w-32 border-0 border-r border-border"
        aria-label="Filter operator"
      >
        {ops.map((o) => (
          <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>
        ))}
      </Select>

      {opNeedsValue(condition.op) && (
        <ValueInput
          condition={condition}
          dataType={meta?.dataType}
          onChange={(value) => onChange({ value })}
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="flex items-center px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label="Remove filter"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function ValueInput({
  condition, dataType, onChange,
}: {
  condition: FilterCondition
  dataType: string | undefined
  onChange: (v: unknown) => void
}) {
  const t = (dataType ?? '').toLowerCase()

  if (opTakesArray(condition.op)) {
    return (
      <Input
        type="text"
        value={Array.isArray(condition.value) ? condition.value.join(', ') : ''}
        placeholder="a, b, c"
        onChange={(e) => {
          const parts = e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
          const coerced = /(int|numeric|decimal|real|double|serial)/.test(t)
            ? parts.map((p) => Number(p)).filter((n) => !Number.isNaN(n))
            : parts
          onChange(coerced)
        }}
        className="h-8 w-48 rounded-none border-0 shadow-none focus-visible:ring-0"
      />
    )
  }

  if (condition.op === 'jsonb_contains') {
    return (
      <Input
        type="text"
        value={typeof condition.value === 'string' ? condition.value : JSON.stringify(condition.value ?? '')}
        placeholder='{"key": "value"}'
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-56 rounded-none border-0 font-mono shadow-none focus-visible:ring-0"
      />
    )
  }

  if (t === 'boolean' || t === 'bool') {
    return (
      <Select
        value={String(condition.value ?? 'true')}
        onChange={(e) => onChange(e.target.value === 'true')}
        className="w-24 border-0 border-r border-border"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    )
  }

  if (t === 'date') {
    return (
      <Input
        type="date"
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-40 rounded-none border-0 shadow-none focus-visible:ring-0"
      />
    )
  }

  if (t.startsWith('timestamp')) {
    return (
      <Input
        type="datetime-local"
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-52 rounded-none border-0 shadow-none focus-visible:ring-0"
      />
    )
  }

  const isNumeric = /(int|numeric|decimal|real|double|serial)/.test(t)
  return (
    <Input
      type={isNumeric ? 'number' : 'text'}
      value={condition.value == null ? '' : String(condition.value)}
      onChange={(e) => {
        const raw = e.target.value
        if (isNumeric) {
          if (raw === '') onChange('')
          else {
            const n = Number(raw)
            onChange(Number.isNaN(n) ? raw : n)
          }
        } else {
          onChange(raw)
        }
      }}
      className="h-8 w-40 rounded-none border-0 shadow-none focus-visible:ring-0"
    />
  )
}
