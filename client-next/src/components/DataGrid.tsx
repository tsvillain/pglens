import { useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Braces, ChevronsUpDown, Key, Link as LinkIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ColumnMeta } from '@/lib/api'
import { Dialog } from '@/components/ui/dialog'
import { JsonViewer, coerceJson, isExpandable } from '@/components/JsonViewer'

export type SortState = { column: string; direction: 'asc' | 'desc' } | null

interface DataGridProps {
  rows: Array<Record<string, unknown>>
  columns: Record<string, ColumnMeta>
  sort: SortState
  onSortChange: (next: SortState) => void
}

type JsonCell = { column: string; value: unknown }

/** jsonb/json columns, or any value that parses to an object/array. */
function isJsonCell(value: unknown, dataType?: string): boolean {
  const t = dataType?.toLowerCase()
  if (t === 'jsonb' || t === 'json') return true
  return isExpandable(coerceJson(value))
}

function renderCell(
  value: unknown,
  dataType: string | undefined,
  onOpenJson: (value: unknown) => void,
): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="italic text-muted-foreground/60">NULL</span>
  }
  if (isJsonCell(value, dataType)) {
    const data = coerceJson(value)
    return (
      <button
        onClick={() => onOpenJson(data)}
        className="flex items-center gap-1 text-sky-600 hover:underline dark:text-sky-400"
        title="View JSON"
      >
        <Braces className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {Array.isArray(data) ? `[${data.length}]` : JSON.stringify(data)}
        </span>
      </button>
    )
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function DataGrid({ rows, columns, sort, onSortChange }: DataGridProps) {
  const columnNames = useMemo(() => Object.keys(columns), [columns])
  const [jsonCell, setJsonCell] = useState<JsonCell | null>(null)

  const colDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columnNames.map((name) => ({
        accessorKey: name,
        header: name,
        cell: (info) =>
          renderCell(info.getValue(), columns[name]?.dataType, (value) =>
            setJsonCell({ column: name, value }),
          ),
      })),
    [columnNames, columns],
  )

  const table = useReactTable({
    data: rows,
    columns: colDefs,
    getCoreRowModel: getCoreRowModel(),
  })

  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
  })

  const totalSize = rowVirtualizer.getTotalSize()
  const virtualRows = rowVirtualizer.getVirtualItems()
  const paddingTop = virtualRows[0]?.start ?? 0
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0)
      : 0

  function toggleSort(name: string) {
    if (sort?.column !== name) onSortChange({ column: name, direction: 'asc' })
    else if (sort.direction === 'asc')
      onSortChange({ column: name, direction: 'desc' })
    else onSortChange(null)
  }

  return (
    <>
    <div
      ref={parentRef}
      className="h-full overflow-auto rounded-md border border-border bg-card"
    >
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const name = header.column.id
                const meta = columns[name]
                const isSorted = sort?.column === name
                return (
                  <th
                    key={header.id}
                    className="select-none border-b border-border px-2 py-2 text-left align-bottom font-medium text-foreground"
                  >
                    <button
                      onClick={() => toggleSort(name)}
                      className="group flex w-full items-center gap-1.5 text-left"
                    >
                      {meta?.isPrimaryKey && (
                        <Key className="h-3 w-3 text-amber-500" />
                      )}
                      {meta?.isForeignKey && (
                        <LinkIcon className="h-3 w-3 text-sky-500" />
                      )}
                      <span className="truncate">{name}</span>
                      <span className="ml-auto text-muted-foreground">
                        {isSorted ? (
                          sort.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-0 group-hover:opacity-50" />
                        )}
                      </span>
                    </button>
                    {meta && (
                      <div className="mt-0.5 text-[10px] font-normal lowercase text-muted-foreground">
                        {meta.dataType}
                      </div>
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr>
              <td style={{ height: paddingTop }} colSpan={columnNames.length} />
            </tr>
          )}
          {virtualRows.map((vr) => {
            const row = table.getRowModel().rows[vr.index]
            if (!row) return null
            return (
              <tr
                key={row.id}
                style={{ height: vr.size }}
                className={cn(
                  'border-b border-border/60',
                  vr.index % 2 === 1 && 'bg-muted/30',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="max-w-[420px] truncate px-2 py-1 align-middle font-mono text-xs"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            )
          })}
          {paddingBottom > 0 && (
            <tr>
              <td
                style={{ height: paddingBottom }}
                colSpan={columnNames.length}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
    <Dialog
      open={jsonCell !== null}
      onClose={() => setJsonCell(null)}
      title={jsonCell?.column ?? 'JSON'}
      className="max-w-2xl"
    >
      {jsonCell && <JsonViewer value={jsonCell.value} />}
    </Dialog>
    </>
  )
}
