import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { Loading, Spinner } from "@/components/ui/spinner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DataGrid, type SortState } from "@/components/DataGrid";
import { EMPTY_FILTER, FilterBar } from "@/components/FilterBar";
import { SortBar } from "@/components/SortBar";
import { ViewBar } from "@/components/ViewBar";
import { InsertRowDialog } from "@/components/InsertRowDialog";
import {
  getTableData, listViews, updateRow,
  type FilterGroup, type SavedView, type TableData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/store/connection";

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
  const [insertOpen, setInsertOpen] = useState(false);

  // Selected saved view id. `null` means the synthetic "All rows" default.
  // The URL is the source of truth so the picker is deep-linkable.
  const selectedViewId = search.view ?? null;

  // Switching tables: drop filter + sort + page, since column names referenced
  // by the prior table's filter won't exist on the new one. The selected
  // view id lives in the URL search params, which TanStack Router clears
  // when the path param changes — but we still reset working state here.
  useEffect(() => {
    setFilter(EMPTY_FILTER);
    setSort([]);
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
    enabled: !!connectionId,
    // Keep previous data only while paginating/sorting within the SAME
    // table. Switching tables must clear so the grid doesn't briefly
    // render the prior table's rows.
    placeholderData: (prev, prevQuery) => {
      if (prevQuery?.queryKey?.[2] === tableName) return prev;
      return undefined;
    },
  });

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
            {data
              ? `${data.totalCount.toLocaleString()} rows · page ${data.page} / ${totalPages}`
              : query.isLoading
                ? <Loading>Loading {tableName} rows…</Loading>
                : ""}
            {isRefetching && (
              <>
                <Spinner className="text-xs" aria-label="Updating" />
                <span>Updating rows…</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.columns && (
            <Button size="sm" onClick={() => setInsertOpen(true)}>
              <Plus className="h-4 w-4" /> Insert row
            </Button>
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
        </div>
      </header>

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
    </div>
  );
}
