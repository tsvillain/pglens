import { useCallback, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Braces,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Key,
  Link as LinkIcon,
  Sigma,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { ColumnMeta, SortEntry } from "@/lib/api";
import { type AggFn, AGG_LABELS, aggsForType, formatAggValue } from "@/lib/aggSql";
import { Dialog } from "@/components/ui/dialog";
import { JsonViewer, coerceJson, isExpandable } from "@/components/JsonViewer";
import { CellEditor } from "@/components/CellEditor";
import { Spinner } from "@/components/ui/spinner";

export type SortState = SortEntry[];

/**
 * `onCommitCell` runs the actual update. It rejects with an Error whose
 * `.message` the grid surfaces inline next to the cell. Parents are
 * responsible for the optimistic cache write — the grid only manages the
 * editor/saving/error UI.
 */
export type CommitCell = (
  rowIndex: number,
  column: string,
  newValue: unknown,
) => Promise<void>;

interface DataGridProps {
  rows: Array<Record<string, unknown>>;
  columns: Record<string, ColumnMeta>;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  /**
   * Enables double-click-to-edit. Requires the table to have a primary key
   * (otherwise we can't pin the UPDATE to one row). Read-only views and PK-
   * less tables should pass false.
   */
  editable?: boolean;
  onCommitCell?: CommitCell;
  /**
   * Click handler for a foreign-key cell. Fired on a single click of a non-
   * null FK value — the parent opens the referenced-row side panel. Omit to
   * render FK cells as plain values (graceful degradation).
   */
  onOpenFk?: (column: string, value: unknown) => void;
  /**
   * Active aggregate function per column (one at a time). Providing
   * `onAggregationChange` enables the per-column aggregations footer; omit it
   * to hide the strip entirely (graceful degradation).
   */
  aggregations?: Record<string, AggFn>;
  /** Computed aggregate value per column, keyed by column name. */
  aggValues?: Record<string, unknown>;
  /** True while the aggregate query is in flight. */
  aggLoading?: boolean;
  onAggregationChange?: (column: string, fn: AggFn | null) => void;
  /** Read-only SQL preview for the active aggregations + filter. */
  aggSqlPreview?: string;
}

/**
 * Header click semantics:
 *   plain click            → make this column the sole sort, cycling its
 *                            direction asc → desc → unsorted
 *   shift / cmd / ctrl-click → toggle this column at the end of the priority
 *                            list, cycling asc → desc → removed
 *
 * Mirrors Airtable / TanStack Table conventions so multi-sort feels familiar.
 */
function nextSortState(
  prev: SortState,
  column: string,
  additive: boolean,
): SortState {
  const idx = prev.findIndex((s) => s.column === column);
  const current = idx >= 0 ? prev[idx] : null;

  if (!additive) {
    if (!current) return [{ column, direction: "asc" }];
    if (current.direction === "asc") return [{ column, direction: "desc" }];
    return [];
  }

  if (!current) return [...prev, { column, direction: "asc" }];
  if (current.direction === "asc") {
    const next = [...prev];
    next[idx] = { column, direction: "desc" };
    return next;
  }
  return prev.filter((_, i) => i !== idx);
}

type JsonCell = { column: string; value: unknown };

/** jsonb/json columns, or any value that parses to an object/array. */
function isJsonCell(value: unknown, dataType?: string): boolean {
  const t = dataType?.toLowerCase();
  if (t === "jsonb" || t === "json") return true;
  return isExpandable(coerceJson(value));
}

function renderCell(
  value: unknown,
  meta: ColumnMeta | undefined,
  onOpenJson: (value: unknown) => void,
  onOpenFk?: (value: unknown) => void,
): React.ReactNode {
  const dataType = meta?.dataType;
  if (value === null || value === undefined) {
    return <span className="italic text-muted-foreground/60">NULL</span>;
  }
  // Foreign-key value → click to follow it to the referenced row. Takes
  // precedence over plain text so the whole value reads as a link, but yields
  // to JSON (an FK column holding json is not a thing in practice).
  if (meta?.isForeignKey && meta.foreignKeyRef && onOpenFk) {
    return (
      <button
        onClick={() => onOpenFk(value)}
        className="flex items-center gap-1 text-violet-600 hover:underline dark:text-violet-400"
        title={`Follow → ${meta.foreignKeyRef.table}.${meta.foreignKeyRef.column}`}
      >
        <LinkIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {typeof value === "object" ? JSON.stringify(value) : String(value)}
        </span>
      </button>
    );
  }
  if (isJsonCell(value, dataType)) {
    const data = coerceJson(value);
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
    );
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function DataGrid({
  rows,
  columns,
  sort,
  onSortChange,
  editable = false,
  onCommitCell,
  onOpenFk,
  aggregations,
  aggValues,
  aggLoading = false,
  onAggregationChange,
  aggSqlPreview,
}: DataGridProps) {
  const columnNames = useMemo(() => Object.keys(columns), [columns]);
  const [jsonCell, setJsonCell] = useState<JsonCell | null>(null);
  const [showAggSql, setShowAggSql] = useState(false);

  const aggEnabled = !!onAggregationChange;
  const activeAggCount = aggregations
    ? Object.keys(aggregations).length
    : 0;

  // editing: which cell is in editor mode right now. Identified by row index
  // (within the current page) + column name. Switching tables/pages discards.
  const [editing, setEditing] = useState<{
    rowIndex: number;
    column: string;
  } | null>(null);
  // Cells with a save in flight. Keyed `${rowIndex}:${column}` so the same
  // (row,col) can transition saving → ok → saving again.
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // Last error message per cell. Cleared on next edit attempt or after a
  // ~5s linger so the user can read it.
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});

  const colDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columnNames.map((name) => ({
        accessorKey: name,
        header: name,
        cell: (info) =>
          renderCell(
            info.getValue(),
            columns[name],
            (value) => setJsonCell({ column: name, value }),
            onOpenFk ? (value) => onOpenFk(name, value) : undefined,
          ),
      })),
    [columnNames, columns, onOpenFk],
  );

  const table = useReactTable({
    data: rows,
    columns: colDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  const totalSize = rowVirtualizer.getTotalSize();
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0)
      : 0;

  function toggleSort(name: string, additive: boolean) {
    onSortChange(nextSortState(sort, name, additive));
  }

  const canEdit = editable && !!onCommitCell;

  const handleCommit = useCallback(
    async (rowIndex: number, column: string, newValue: unknown) => {
      const key = `${rowIndex}:${column}`;
      setEditing(null);
      if (!onCommitCell) return;
      setSaving((s) => {
        const next = new Set(s);
        next.add(key);
        return next;
      });
      setCellErrors((e) => {
        if (!(key in e)) return e;
        const { [key]: _drop, ...rest } = e;
        return rest;
      });
      try {
        await onCommitCell(rowIndex, column, newValue);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setCellErrors((e) => ({ ...e, [key]: message }));
        // Clear the error after a few seconds so it doesn't linger forever.
        setTimeout(() => {
          setCellErrors((e) => {
            if (e[key] !== message) return e;
            const { [key]: _drop, ...rest } = e;
            return rest;
          });
        }, 6000);
      } finally {
        setSaving((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [onCommitCell],
  );

  function tryStartEdit(rowIndex: number, column: string) {
    if (!canEdit) return;
    // Primary-key columns are part of the WHERE used to address the row;
    // letting users edit them via inline editor would corrupt that mapping.
    // (PK changes belong in a more deliberate "row edit" surface.)
    if (columns[column]?.isPrimaryKey) return;
    // The braces affordance on JSON cells handles its own click → opens a
    // read-only viewer. A double-click is two clicks plus a dblclick, so the
    // viewer may already be open. Close it before mounting the edit dialog
    // so we don't end up with two modals stacked.
    setJsonCell(null);
    setEditing({ rowIndex, column });
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card"
      >
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const name = header.column.id;
                  const meta = columns[name];
                  const sortIdx = sort.findIndex((s) => s.column === name);
                  const sortEntry = sortIdx >= 0 ? sort[sortIdx] : null;
                  const showPriority = sortEntry && sort.length > 1;
                  return (
                    <th
                      key={header.id}
                      className="select-none border-b border-border px-2 py-2 text-left align-bottom font-medium text-foreground"
                    >
                      <button
                        onClick={(e) =>
                          toggleSort(name, e.shiftKey || e.metaKey || e.ctrlKey)
                        }
                        title="Click to sort. Shift-click to add to multi-sort."
                        className="group flex w-full items-center gap-1.5 text-left"
                      >
                        {meta?.isPrimaryKey && (
                          <Key className="h-3 w-3 text-amber-500" />
                        )}
                        {meta?.isForeignKey && (
                          <LinkIcon className="h-3 w-3 text-sky-500" />
                        )}
                        <span className="truncate">{name}</span>
                        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                          {showPriority && (
                            <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                              {sortIdx + 1}
                            </span>
                          )}
                          {sortEntry ? (
                            sortEntry.direction === "asc" ? (
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
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td
                  style={{ height: paddingTop }}
                  colSpan={columnNames.length}
                />
              </tr>
            )}
            {virtualRows.map((vr) => {
              const row = table.getRowModel().rows[vr.index];
              if (!row) return null;
              return (
                <tr
                  key={row.id}
                  style={{ height: vr.size }}
                  className={cn(
                    "border-b border-border/60",
                    vr.index % 2 === 1 && "bg-muted/30",
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const column = cell.column.id;
                    const meta = columns[column];
                    const key = `${vr.index}:${column}`;
                    const isEditing =
                      editing?.rowIndex === vr.index &&
                      editing.column === column;
                    const isSaving = saving.has(key);
                    const error = cellErrors[key];
                    const cellEditable =
                      canEdit && meta != null && !meta.isPrimaryKey;
                    return (
                      <td
                        key={cell.id}
                        onDoubleClick={() => tryStartEdit(vr.index, column)}
                        className={cn(
                          "relative max-w-[420px] truncate px-2 py-1 align-middle font-mono text-xs",
                          cellEditable && "cursor-text",
                          isEditing && "overflow-visible",
                          error &&
                            "ring-1 ring-inset ring-destructive/60 bg-destructive/5",
                        )}
                        title={
                          error
                            ? error
                            : cellEditable
                              ? "Double-click to edit"
                              : undefined
                        }
                      >
                        {isEditing && meta ? (
                          <CellEditor
                            meta={meta}
                            value={cell.getValue()}
                            onCommit={(next) =>
                              handleCommit(vr.index, column, next)
                            }
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          <span
                            className={cn(
                              "flex items-center gap-1.5",
                              isSaving && "opacity-50",
                            )}
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                            {isSaving && (
                              <Spinner
                                className="h-3 w-3 shrink-0"
                                aria-label="Saving"
                              />
                            )}
                            {error && !isSaving && (
                              <AlertCircle
                                className="h-3 w-3 shrink-0 text-destructive"
                                aria-label={error}
                              />
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
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
          {aggEnabled && (
            <tfoot className="sticky bottom-0 z-10 bg-card">
              <tr className="border-t border-border">
                {columnNames.map((name) => (
                  <td
                    key={name}
                    className="border-r border-border/40 px-2 py-1 align-top last:border-r-0"
                  >
                    <AggFooterCell
                      meta={columns[name]}
                      fn={aggregations?.[name] ?? null}
                      value={aggValues?.[name]}
                      loading={aggLoading}
                      onChange={(fn) => onAggregationChange!(name, fn)}
                    />
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {aggEnabled && activeAggCount > 0 && (
        <div className="mt-2 shrink-0 text-sm">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Sigma className="h-3.5 w-3.5" />
              {activeAggCount} aggregation{activeAggCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={() => {
                for (const name of Object.keys(aggregations ?? {})) {
                  onAggregationChange!(name, null);
                }
              }}
              className="hover:text-foreground"
            >
              Clear
            </button>
            {aggSqlPreview && (
              <button
                type="button"
                onClick={() => setShowAggSql((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
              >
                {showAggSql ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronUp className="h-3 w-3" />
                )}
                Show SQL
              </button>
            )}
          </div>
          {showAggSql && aggSqlPreview && (
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
              {aggSqlPreview}
            </pre>
          )}
        </div>
      )}
      </div>
      <Dialog
        open={jsonCell !== null}
        onClose={() => setJsonCell(null)}
        title={jsonCell?.column ?? "JSON"}
        className="max-w-2xl"
      >
        {jsonCell && <JsonViewer value={jsonCell.value} />}
      </Dialog>
    </>
  );
}

/**
 * One column's slot in the aggregations footer: a compact function picker plus
 * the computed value. The function list is gated by the column's type, mirroring
 * the server. Selecting the blank option clears the aggregate for that column.
 */
function AggFooterCell({
  meta,
  fn,
  value,
  loading,
  onChange,
}: {
  meta: ColumnMeta | undefined;
  fn: AggFn | null;
  value: unknown;
  loading: boolean;
  onChange: (fn: AggFn | null) => void;
}) {
  const fns = useMemo(() => aggsForType(meta?.dataType), [meta?.dataType]);

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <select
        value={fn ?? ""}
        onChange={(e) =>
          onChange(e.target.value ? (e.target.value as AggFn) : null)
        }
        aria-label="Aggregate function"
        className={cn(
          "h-6 w-full max-w-[160px] rounded border border-transparent bg-transparent px-1 text-[11px] text-muted-foreground outline-none",
          "hover:border-border focus:border-border",
          fn && "text-foreground",
        )}
      >
        <option value="">∑ —</option>
        {fns.map((f) => (
          <option key={f} value={f}>
            {AGG_LABELS[f]}
          </option>
        ))}
      </select>
      {fn && (
        <span className="flex items-center gap-1 truncate px-1 font-mono text-xs font-medium text-foreground">
          {loading ? (
            <Spinner className="h-3 w-3" aria-label="Computing" />
          ) : (
            formatAggValue(value)
          )}
        </span>
      )}
    </div>
  );
}
