import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { DataGrid, type SortState } from '@/components/DataGrid'
import { getTableData } from '@/lib/api'
import { useConnectionStore } from '@/store/connection'

const PAGE_SIZES = [50, 100, 250, 500] as const

export function TableView() {
  const { tableName } = useParams({ from: '/tables/$tableName' })
  const connectionId = useConnectionStore((s) => s.activeConnectionId)

  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState<number>(100)
  const [sort, setSort] = useState<SortState>(null)

  const query = useQuery({
    queryKey: ['table', connectionId, tableName, page, limit, sort],
    queryFn: ({ signal }) =>
      getTableData(
        connectionId!,
        tableName,
        {
          page,
          limit,
          sortColumn: sort?.column ?? null,
          sortDirection: sort?.direction,
        },
        signal,
      ),
    enabled: !!connectionId,
    placeholderData: keepPreviousData,
  })

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection. Pick one in the sidebar.
      </div>
    )
  }

  const data = query.data
  const totalPages = data ? Math.max(1, Math.ceil(data.totalCount / limit)) : 1

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{tableName}</h1>
          <p className="text-xs text-muted-foreground">
            {data
              ? `${data.totalCount.toLocaleString()} rows · page ${data.page} / ${totalPages}`
              : query.isLoading
                ? 'Loading…'
                : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={String(limit)}
            onChange={(e) => {
              setPage(1)
              setLimit(Number(e.target.value))
            }}
            className="w-24"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
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

      <div className="min-h-0 flex-1 p-4">
        {query.error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {(query.error as Error).message}
          </div>
        )}
        {!query.error && data && (
          <DataGrid
            rows={data.rows}
            columns={data.columns}
            sort={sort}
            onSortChange={(s) => {
              setPage(1)
              setSort(s)
            }}
          />
        )}
        {!data && query.isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    </div>
  )
}
