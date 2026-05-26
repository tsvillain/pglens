import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Loading, Spinner } from "@/components/ui/spinner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DataGrid, type SortState } from "@/components/DataGrid";
import { EMPTY_FILTER, FilterBar } from "@/components/FilterBar";
import { getTableData, type FilterGroup } from "@/lib/api";
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

export function TableView() {
  const { tableName } = useParams({ from: "/tables/$tableName" });
  const connectionId = useConnectionStore((s) => s.activeConnectionId);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<number>(100);
  const [sort, setSort] = useState<SortState>(null);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);

  // Switching tables: drop filter + sort + page, since column names referenced
  // by the prior table's filter won't exist on the new one.
  useEffect(() => {
    setFilter(EMPTY_FILTER);
    setSort(null);
    setPage(1);
  }, [tableName]);

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
          sortColumn: sort?.column ?? null,
          sortDirection: sort?.direction,
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

      {data?.columns && (
        <FilterBar
          columns={data.columns}
          filter={filter}
          onChange={(next) => {
            setPage(1);
            setFilter(next);
          }}
        />
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
            />
          </div>
        )}
        {!data && query.isLoading && (
          <Loading className="text-sm text-muted-foreground">
            Loading {tableName} rows…
          </Loading>
        )}
      </div>
    </div>
  );
}
