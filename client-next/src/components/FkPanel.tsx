import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Key,
  Link as LinkIcon,
  Pencil,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/spinner";
import { CellEditor } from "@/components/CellEditor";
import { JsonViewer, coerceJson, isExpandable } from "@/components/JsonViewer";
import {
  getTableData,
  updateRow,
  type ColumnMeta,
  type FilterGroup,
  type TableData,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * One hop in the click-through chain. We display the row living at
 * `refTable` WHERE `refColumn` = `refValue` (the referenced row). `origin*`
 * records where we arrived FROM, so the panel can offer "show all rows in
 * <originTable> where <originColumn> = <originValue>" — the reverse jump back
 * to the sibling set that shares this foreign key.
 */
export interface FkTarget {
  refTable: string;
  refColumn: string;
  refValue: unknown;
  originTable: string;
  originColumn: string;
  originValue: unknown;
}

interface FkPanelProps {
  connectionId: string;
  /**
   * The first hop. The panel owns deeper chain state internally; remount it
   * with a fresh `key` when the user clicks a different FK in the grid so the
   * chain resets.
   */
  target: FkTarget;
  onClose: () => void;
  /** Jump to `table` with `column = value` pre-applied (opens/activates its tab). */
  onShowReferencing: (table: string, column: string, value: unknown) => void;
}

/** Build the single-equality filter that pins the referenced row. */
function eqFilter(column: string, value: unknown): FilterGroup {
  return {
    type: "group",
    combinator: "and",
    children: [{ type: "condition", column, op: "eq", value }],
  };
}

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function FkPanel({
  connectionId,
  target,
  onClose,
  onShowReferencing,
}: FkPanelProps) {
  const qc = useQueryClient();
  const [stack, setStack] = useState<FkTarget[]>([target]);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [editingField, setEditingField] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const frame = stack[stack.length - 1];
  const depth = stack.length;

  // Esc closes the panel (matching the modal-dismiss convention elsewhere).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Returning to view mode whenever the displayed row changes keeps a stale
  // editor from carrying across hops.
  useEffect(() => {
    setMode("view");
    setEditingField(null);
    setFieldError(null);
  }, [depth, frame.refTable, frame.refColumn, frame.refValue]);

  const queryKey = [
    "fkrow",
    connectionId,
    frame.refTable,
    frame.refColumn,
    frame.refValue,
  ] as const;

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getTableData(
        connectionId,
        frame.refTable,
        { limit: 1, filter: eqFilter(frame.refColumn, frame.refValue) },
        signal,
      ),
    enabled: !!connectionId,
  });

  const data = query.data;
  const row = data?.rows[0];
  const columns = data?.columns;
  const canEdit = !!data?.hasPrimaryKey;

  function followFk(fieldName: string, meta: ColumnMeta, value: unknown) {
    if (value === null || value === undefined || !meta.foreignKeyRef) return;
    setStack((s) => [
      ...s,
      {
        refTable: meta.foreignKeyRef!.table,
        refColumn: meta.foreignKeyRef!.column,
        refValue: value,
        originTable: frame.refTable,
        originColumn: fieldName,
        originValue: value,
      },
    ]);
  }

  async function commitField(column: string, newValue: unknown) {
    if (!row || !columns) return;
    const pkCols = Object.entries(columns)
      .filter(([, m]) => m.isPrimaryKey)
      .map(([name]) => name);
    const where: Record<string, unknown> = {};
    for (const pk of pkCols) where[pk] = row[pk];

    setEditingField(null);
    setFieldError(null);
    try {
      const updated = await updateRow(connectionId, frame.refTable, {
        where,
        set: { [column]: newValue },
      });
      // Server-returned row supersedes our guess (triggers/defaults/coercion).
      qc.setQueryData<TableData>(queryKey, (cur) =>
        cur ? { ...cur, rows: [updated] } : cur,
      );
      // The referenced row may also be on screen in its own table tab — drop
      // those caches so they refetch the edited value.
      qc.invalidateQueries({
        queryKey: ["table", connectionId, frame.refTable],
      });
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      {/* Click-away backdrop. */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-[90vw] flex-col border-l border-border bg-card shadow-2xl"
        role="dialog"
        aria-label={`Referenced row in ${frame.refTable}`}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          {depth > 1 && (
            <button
              onClick={() => setStack((s) => s.slice(0, -1))}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Back"
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LinkIcon className="h-3 w-3 text-violet-500" />
              <span className="truncate">
                {frame.originTable}.{frame.originColumn} →
              </span>
            </div>
            <h2 className="truncate font-semibold">{frame.refTable}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {query.isLoading && (
            <Loading className="text-sm text-muted-foreground">
              Loading referenced row…
            </Loading>
          )}
          {query.error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {(query.error as Error).message}
            </div>
          )}
          {data && !row && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              No row found in <span className="font-mono">{frame.refTable}</span>{" "}
              where{" "}
              <span className="font-mono">
                {frame.refColumn} = {displayScalar(frame.refValue)}
              </span>
              . The reference may be dangling.
            </div>
          )}

          {row && columns && (
            <dl className="divide-y divide-border/60">
              {Object.entries(columns).map(([name, meta]) => {
                const value = row[name];
                const isEditingThis = editingField === name;
                const editableField =
                  mode === "edit" && canEdit && !meta.isPrimaryKey;
                return (
                  <div key={name} className="py-2">
                    <dt className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      {meta.isPrimaryKey && (
                        <Key className="h-3 w-3 text-amber-500" />
                      )}
                      {meta.isForeignKey && (
                        <LinkIcon className="h-3 w-3 text-violet-500" />
                      )}
                      <span className="truncate">{name}</span>
                      <span className="ml-auto lowercase text-muted-foreground/70">
                        {meta.dataType}
                      </span>
                    </dt>
                    <dd className="mt-0.5 font-mono text-xs">
                      {isEditingThis ? (
                        <CellEditor
                          meta={meta}
                          value={value}
                          onCommit={(next) => commitField(name, next)}
                          onCancel={() => setEditingField(null)}
                        />
                      ) : (
                        <FieldValue
                          meta={meta}
                          value={value}
                          editable={editableField}
                          onEdit={() => {
                            setFieldError(null);
                            setEditingField(name);
                          }}
                          onFollow={() => followFk(name, meta, value)}
                        />
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}

          {fieldError && (
            <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {fieldError}
            </div>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-border px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() =>
              onShowReferencing(
                frame.originTable,
                frame.originColumn,
                frame.originValue,
              )
            }
          >
            <ExternalLink className="h-4 w-4" />
            <span className="truncate">
              Show all rows in {frame.originTable} where {frame.originColumn} ={" "}
              {displayScalar(frame.originValue)}
            </span>
          </Button>
          {mode === "view" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={!canEdit}
              title={
                canEdit
                  ? undefined
                  : "Referenced table has no primary key — editing disabled"
              }
              onClick={() => setMode("edit")}
            >
              <Pencil className="h-4 w-4" /> Edit referenced row
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setMode("view");
                setEditingField(null);
              }}
            >
              Done editing
            </Button>
          )}
        </footer>
      </aside>
    </>
  );
}

interface FieldValueProps {
  meta: ColumnMeta;
  value: unknown;
  editable: boolean;
  onEdit: () => void;
  onFollow: () => void;
}

function FieldValue({ meta, value, editable, onEdit, onFollow }: FieldValueProps) {
  const isNull = value === null || value === undefined;
  const json = coerceJson(value);
  const showJson =
    !isNull &&
    (meta.dataType?.toLowerCase() === "json" ||
      meta.dataType?.toLowerCase() === "jsonb" ||
      isExpandable(json));

  const content = isNull ? (
    <span className="italic text-muted-foreground/60">NULL</span>
  ) : meta.isForeignKey && meta.foreignKeyRef ? (
    <button
      onClick={onFollow}
      className="flex items-center gap-1 text-left text-violet-600 hover:underline dark:text-violet-400"
      title={`Follow → ${meta.foreignKeyRef.table}.${meta.foreignKeyRef.column}`}
    >
      <LinkIcon className="h-3 w-3 shrink-0" />
      <span className="break-all">{displayScalar(value)}</span>
    </button>
  ) : showJson ? (
    <div className="rounded-md border border-border bg-background p-2">
      <JsonViewer value={json} />
    </div>
  ) : (
    <span className="break-all">{displayScalar(value)}</span>
  );

  if (!editable) return content;
  return (
    <div className="group flex items-start gap-1">
      <div className="min-w-0 flex-1">{content}</div>
      <button
        onClick={onEdit}
        className={cn(
          "shrink-0 rounded p-0.5 text-muted-foreground opacity-0",
          "hover:bg-accent hover:text-foreground group-hover:opacity-100",
        )}
        aria-label="Edit field"
        title="Edit"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}
