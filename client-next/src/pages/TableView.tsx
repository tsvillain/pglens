import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Upload } from "lucide-react";

import { Loading, Spinner } from "@/components/ui/spinner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DataGrid, type SortState } from "@/components/DataGrid";
import { EMPTY_FILTER, FilterBar } from "@/components/FilterBar";
import { SortBar } from "@/components/SortBar";
import { ViewBar } from "@/components/ViewBar";
import { InsertRowDialog } from "@/components/InsertRowDialog";
import { ImportDialog } from "@/components/ImportDialog";
import { ExportMenu } from "@/components/ExportMenu";
import { FkPanel, type FkTarget } from "@/components/FkPanel";
import { ModeToggle } from "@/components/ModeToggle";
import { SqlConsole } from "@/components/SqlConsole";
import {
  getAggregates, getTableData, listViews, updateRow,
  type ColumnMeta, type FilterGroup, type SavedView, type TableData,
} from "@/lib/api";
import { type AggFn, previewAggregate } from "@/lib/aggSql";
import { buildTableSelect } from "@/lib/tableSql";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/store/connection";
import { tabId } from "@/store/tabs";
import { type TabMode, useTabModeStore } from "@/store/tabMode";

const PAGE_SIZES = [50, 100, 250, 500] as const;

/**
 * Strip conditions whose value isn't ready yet (newly-added rows with empty
 * input) so the server isn't asked to filter on an empty string against a
 * non-text column. Valueless ops (`IS NULL`/`IS NOT NULL`) and array ops
 * with a populated array stay in.
 */
function pruneIncomplete(filter: FilterGroup): FilterGroup {
  return {
    ...filter,
    children: filter.children.filter((c) => {
      if (c.type !== "condition") return true;
      if (c.op === "is_null" || c.op === "is_not_null") return true;
      if (c.op === "in" || c.op === "nin" || c.op === "array_overlaps") {
        return Array.isArray(c.value) && c.value.length > 0;
      }
      return c.value !== "" && c.value != null;
    }),
  };
}

/**
 * Coerce an FK value that crossed the URL as a string back to the JS type the
 * referenced column expects, so the equality filter binds correctly (an int
 * column needs `42`, not `"42"`).
 */
function coerceFkValue(raw: string, meta: ColumnMeta | undefined): unknown {
  const t = (meta?.dataType ?? "").toLowerCase();
  if (/(int|numeric|decimal|real|double|serial)/.test(t)) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (t === "boolean" || t === "bool") return raw === "true";
  return raw;
}

/** Materialize a saved view into the working filter/sort the table renders. */
function snapshotFromView(view: SavedView): {
  filter: FilterGroup;
  sort: SortState;
} {
  const filter =
    view.filter && view.filter.children.length > 0
      ? (view.filter as FilterGroup)
      : EMPTY_FILTER;
  const sort: SortState = (view.sort ?? []).map((s) => ({
    column: s.column,
    // Persisted views may have upper-case directions; normalize.
    direction: s.direction.toLowerCase() as "asc" | "desc",
  }));
  return { filter, sort };
}

export function TableView() {
  const { tableName } = useParams({ from: "/tables/$tableName" });
  const search = useSearch({ from: "/tables/$tableName" });
  const navigate = useNavigate({ from: "/tables/$tableName" });
  const connectionId = useConnectionStore((s) => s.activeConnectionId);
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<number>(100);
  const [sort, setSort] = useState<SortState>([]);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);
  // Active aggregate function per column (at most one each). Drives the
  // per-column footer in the grid.
  const [aggregations, setAggregations] = useState<Record<string, AggFn>>({});
  const [insertOpen, setInsertOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The FK cell the user clicked → drives the referenced-row side panel.
  const [fkTarget, setFkTarget] = useState<FkTarget | null>(null);

  // Selected saved view id. `null` means the synthetic "All rows" default.
  // The URL is the source of truth so the picker is deep-linkable.
  const selectedViewId = search.view ?? null;

  // Per-tab Advanced toggle (roadmap §5.1). Mode + edited SQL are keyed by tab
  // id so flipping back to No-code preserves the query the user was writing.
  const tid = tabId({ kind: "table", tableName });
  const mode = useTabModeStore((s) => s.mode[tid] ?? "nocode");
  const advancedSql = useTabModeStore((s) => s.sql[tid]);
  const setMode = useTabModeStore((s) => s.setMode);
  const setTabSql = useTabModeStore((s) => s.setSql);

  // Switching tables: drop filter + sort + page, since column names referenced
  // by the prior table's filter won't exist on the new one. The selected
  // view id lives in the URL search params, which TanStack Router clears
  // when the path param changes — but we still reset working state here.
  useEffect(() => {
    setFilter(EMPTY_FILTER);
    setSort([]);
    setAggregations({});
    setPage(1);
  }, [tableName]);

  // Hydrate filter + sort from the selected view. We re-fetch the list to
  // avoid a separate single-view endpoint; the data is already cached for
  // the ViewBar so this is free in steady state.
  const lastHydratedView = useRef<string | null>(null);
  useEffect(() => {
    if (!connectionId) return;
    // Re-hydrate when the URL view id changes (including becoming null).
    if (lastHydratedView.current === selectedViewId) return;
    lastHydratedView.current = selectedViewId;

    if (selectedViewId === null) {
      // "All rows" — reset to a clean slate.
      setFilter(EMPTY_FILTER);
      setSort([]);
      setPage(1);
      return;
    }

    let cancelled = false;
    qc.fetchQuery({
      queryKey: ['views', connectionId, tableName],
      queryFn: ({ signal }) =>
        listViews({ connectionId, tableName }, signal).then((r) => r.views),
    }).then((vs) => {
      if (cancelled) return;
      const view = vs.find((v) => v.id === selectedViewId);
      if (!view) {
        // Stale URL — clear the param so we don't re-attempt every render.
        navigate({ search: {}, replace: true });
        return;
      }
      const snap = snapshotFromView(view);
      setFilter(snap.filter);
      setSort(snap.sort);
      setPage(1);
    }).catch(() => {
      // Network failure leaves working state untouched.
    });
    return () => {
      cancelled = true;
    };
  }, [selectedViewId, connectionId, tableName, qc, navigate]);

  // Incomplete conditions (newly-added rows with empty values) would 400 the
  // server, so prune them from the version sent — the UI keeps the row open
  // for editing.
  const appliedFilter = pruneIncomplete(filter);

  // The SELECT no-code mode is about to run — seeds the Advanced editor.
  const generatedSql = useMemo(
    () => buildTableSelect({ tableName, filter: appliedFilter, sort, limit, page }),
    [tableName, appliedFilter, sort, limit, page],
  );

  // Flip mode. Entering Advanced for the first time seeds the editor with the
  // current no-code SQL; an existing edit is preserved (never clobbered).
  const switchMode = (next: TabMode) => {
    if (next === "advanced" && advancedSql == null) setTabSql(tid, generatedSql);
    setMode(tid, next);
  };

  const query = useQuery({
    queryKey: ["table", connectionId, tableName, page, limit, sort, appliedFilter],
    queryFn: ({ signal }) =>
      getTableData(
        connectionId!,
        tableName,
        {
          page,
          limit,
          sort,
          filter: appliedFilter,
        },
        signal,
      ),
    // Skip the grid read while in Advanced mode — its results aren't shown.
    // React Query keeps the cache, so flipping back is instant.
    enabled: !!connectionId && mode === "nocode",
    // Keep previous data only while paginating/sorting within the SAME
    // table. Switching tables must clear so the grid doesn't briefly
    // render the prior table's rows.
    placeholderData: (prev, prevQuery) => {
      if (prevQuery?.queryKey?.[2] === tableName) return prev;
      return undefined;
    },
  });

  // Aggregations strip: one running aggregate per chosen column, recomputed
  // server-side against the same filter as the data read.
  const aggList = useMemo(
    () => Object.entries(aggregations).map(([column, fn]) => ({ column, fn })),
    [aggregations],
  );

  const aggQuery = useQuery({
    queryKey: ["aggregate", connectionId, tableName, appliedFilter, aggList],
    queryFn: ({ signal }) =>
      getAggregates(
        connectionId!,
        tableName,
        { filter: appliedFilter, aggs: aggList },
        signal,
      ),
    enabled: !!connectionId && aggList.length > 0 && mode === "nocode",
    // Keep prior values on screen while recomputing so the footer doesn't flash.
    placeholderData: (prev) => prev,
  });

  const aggValues = useMemo(() => {
    const map: Record<string, unknown> = {};
    for (const r of aggQuery.data?.results ?? []) map[r.column] = r.value;
    return map;
  }, [aggQuery.data]);

  const aggSqlPreview = useMemo(
    () => previewAggregate(tableName, aggList, appliedFilter),
    [tableName, aggList, appliedFilter],
  );

  // FK click-through landing: `?fkcol&fkval` arrives from the panel's "show
  // all rows that reference this row" jump. Apply it as a single equality
  // filter once column metadata is loaded (so the value can be type-coerced),
  // then strip the params — the user owns the filter from there.
  const lastFkApplied = useRef<string | null>(null);
  useEffect(() => {
    const { fkcol, fkval } = search;
    if (fkcol == null || fkval == null) {
      lastFkApplied.current = null;
      return;
    }
    const cols = query.data?.columns;
    if (!cols) return; // wait for metadata so we can type-coerce the value
    const key = `${tableName}|${fkcol}=${fkval}`;
    if (lastFkApplied.current === key) return;
    lastFkApplied.current = key;

    if (cols[fkcol]) {
      setPage(1);
      setFilter({
        type: "group",
        combinator: "and",
        children: [
          {
            type: "condition",
            column: fkcol,
            op: "eq",
            value: coerceFkValue(fkval, cols[fkcol]),
          },
        ],
      });
    }
    navigate({
      search: (prev: { view?: string }) =>
        prev.view ? { view: prev.view } : {},
      replace: true,
    });
  }, [search, tableName, query.data, navigate]);

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection. Pick one in the sidebar.
      </div>
    );
  }

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.totalCount / limit)) : 1;
  // True while a refetch (page/sort/limit change) is in flight but we still
  // have prior data on screen — surface a non-blocking loading hint.
  const isRefetching = query.isFetching && !query.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top progress bar — visible only mid-refetch. */}
      <div
        className={cn(
          "h-0.5 origin-left bg-primary transition-opacity",
          isRefetching ? "opacity-100" : "opacity-0",
          isRefetching && "animate-pulse",
        )}
      />
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{tableName}</h1>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {mode === "advanced"
              ? "Advanced mode (raw SQL)"
              : data
                ? `${data.totalCount.toLocaleString()} rows · page ${data.page} / ${totalPages}`
                : query.isLoading
                  ? <Loading>Loading {tableName} rows…</Loading>
                  : ""}
            {mode === "nocode" && isRefetching && (
              <>
                <Spinner className="text-xs" aria-label="Updating" />
                <span>Updating rows…</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle mode={mode} onChange={switchMode} />
          {mode === "nocode" && (
            <>
              {data?.columns && (
                <>
                  <Button size="sm" onClick={() => setInsertOpen(true)}>
                    <Plus className="h-4 w-4" /> Insert row
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                    <Upload className="h-4 w-4" /> Import
                  </Button>
                  <ExportMenu
                    connectionId={connectionId}
                    tableName={tableName}
                    columns={data.columns}
                    filter={appliedFilter}
                    sort={sort}
                  />
                </>
              )}
              <Select
                value={String(limit)}
                onChange={(e) => {
                  setPage(1);
                  setLimit(Number(e.target.value));
                }}
                className="w-28"
                aria-label="Rows per page"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} rows
                  </option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="outline"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                onClick={() => setPage((p) => p + 1)}
                disabled={!data || page >= totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </header>

      {mode === "advanced" ? (
        <div className="min-h-0 flex-1">
          <SqlConsole
            connectionId={connectionId}
            tabId={tid}
            value={advancedSql ?? generatedSql}
            onChange={(v) => setTabSql(tid, v)}
            onRegenerate={() => setTabSql(tid, generatedSql)}
          />
        </div>
      ) : (
      <>
      <ViewBar
        connectionId={connectionId}
        tableName={tableName}
        selectedViewId={selectedViewId}
        onSelectView={(id) =>
          navigate({
            search: id ? { view: id } : {},
            replace: true,
          })
        }
        filter={filter}
        sort={sort}
      />

      {data?.columns && (
        <>
          <FilterBar
            columns={data.columns}
            filter={filter}
            onChange={(next) => {
              setPage(1);
              setFilter(next);
            }}
          />
          <SortBar
            columns={data.columns}
            sort={sort}
            onChange={(next) => {
              setPage(1);
              setSort(next);
            }}
          />
        </>
      )}

      <div className="min-h-0 flex-1 p-4">
        {query.error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {(query.error as Error).message}
          </div>
        )}
        {!query.error && data && (
          <div
            className={cn(
              "h-full transition-opacity duration-150",
              isRefetching && "opacity-60",
            )}
          >
            <DataGrid
              rows={data.rows}
              columns={data.columns}
              sort={sort}
              onSortChange={(s) => {
                setPage(1);
                setSort(s);
              }}
              onOpenFk={(column, value) => {
                const meta = data.columns[column];
                if (!meta?.foreignKeyRef || value == null) return;
                setFkTarget({
                  refTable: meta.foreignKeyRef.table,
                  refColumn: meta.foreignKeyRef.column,
                  refValue: value,
                  originTable: tableName,
                  originColumn: column,
                  originValue: value,
                });
              }}
              aggregations={aggregations}
              aggValues={aggValues}
              aggLoading={aggQuery.isFetching}
              aggSqlPreview={aggSqlPreview}
              onAggregationChange={(column, fn) =>
                setAggregations((prev) => {
                  if (fn === null) {
                    const { [column]: _drop, ...rest } = prev;
                    return rest;
                  }
                  return { ...prev, [column]: fn };
                })
              }
              editable={data.hasPrimaryKey}
              onCommitCell={async (rowIndex, column, newValue) => {
                const queryKey = [
                  "table",
                  connectionId,
                  tableName,
                  page,
                  limit,
                  sort,
                  appliedFilter,
                ] as const;
                const snapshot = qc.getQueryData<TableData>(queryKey);
                const row = snapshot?.rows[rowIndex];
                if (!snapshot || !row) {
                  throw new Error("Row no longer in view — reload and retry.");
                }
                // Build `where` from all PK columns on the row. The server
                // re-validates and rejects if any column went missing.
                const pkCols = Object.entries(snapshot.columns)
                  .filter(([, m]) => m.isPrimaryKey)
                  .map(([name]) => name);
                const where: Record<string, unknown> = {};
                for (const pk of pkCols) where[pk] = row[pk];

                // Optimistic patch — flip the cell now so the grid clears
                // the editor without flicker. Roll back on error.
                qc.setQueryData<TableData>(queryKey, (cur) => {
                  if (!cur) return cur;
                  const nextRows = cur.rows.slice();
                  nextRows[rowIndex] = { ...row, [column]: newValue };
                  return { ...cur, rows: nextRows };
                });

                try {
                  const updated = await updateRow(connectionId!, tableName, {
                    where,
                    set: { [column]: newValue },
                  });
                  // Server-returned row supersedes the optimistic guess
                  // (triggers, defaults, type coercion may have altered it).
                  qc.setQueryData<TableData>(queryKey, (cur) => {
                    if (!cur) return cur;
                    const nextRows = cur.rows.slice();
                    nextRows[rowIndex] = updated;
                    return { ...cur, rows: nextRows };
                  });
                } catch (err) {
                  // Roll back the optimistic write.
                  qc.setQueryData<TableData>(queryKey, (cur) => {
                    if (!cur) return cur;
                    const nextRows = cur.rows.slice();
                    nextRows[rowIndex] = row;
                    return { ...cur, rows: nextRows };
                  });
                  throw err;
                }
              }}
            />
          </div>
        )}
        {!data && query.isLoading && (
          <Loading className="text-sm text-muted-foreground">
            Loading {tableName} rows…
          </Loading>
        )}
      </div>
      </>
      )}

      {data?.columns && (
        <InsertRowDialog
          open={insertOpen}
          onClose={() => setInsertOpen(false)}
          connectionId={connectionId}
          tableName={tableName}
          columns={data.columns}
          onInserted={() => {
            // Refetch every page/sort/filter variant of this table so the new
            // row appears wherever the user lands.
            qc.invalidateQueries({
              queryKey: ["table", connectionId, tableName],
            });
          }}
        />
      )}

      {data?.columns && (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          connectionId={connectionId}
          tableName={tableName}
          columns={data.columns}
          onImported={() => {
            qc.invalidateQueries({
              queryKey: ["table", connectionId, tableName],
            });
          }}
        />
      )}

      {fkTarget && (
        <FkPanel
          // Remount on a new FK click so the click-through chain resets.
          key={`${fkTarget.refTable}:${fkTarget.refColumn}:${String(fkTarget.refValue)}`}
          connectionId={connectionId}
          target={fkTarget}
          onClose={() => setFkTarget(null)}
          onShowReferencing={(table, column, value) => {
            setFkTarget(null);
            navigate({
              to: "/tables/$tableName",
              params: { tableName: table },
              search: { fkcol: column, fkval: String(value) },
            });
          }}
        />
      )}
    </div>
  );
}
