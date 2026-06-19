import { useQuery } from '@tanstack/react-query'

import { Dialog } from '@/components/ui/dialog'
import { Loading } from '@/components/ui/spinner'
import { ExplainPlan } from '@/components/ExplainPlan'
import { runQuery } from '@/lib/api'
import { buildExplainJsonSql } from '@/lib/explainSql'

/**
 * Runs `EXPLAIN (… FORMAT JSON) <sql>` as a normal query and shows the §6.3
 * plan visualizer in a dialog. Used by the no-code "Explain plan" button and
 * the slow-query "Visualize plan" drilldown action — the two entry points that
 * aren't already inside the Advanced-mode editor.
 *
 * This is always a plain EXPLAIN (estimates only — nothing executes), so it is
 * safe to fire on any query, including writes and pg_stat_statements normalized
 * statements (which plan via GENERIC_PLAN; see buildExplainJsonSql).
 */
export function ExplainPlanDialog({
  open,
  onClose,
  connectionId,
  sql,
  title = 'Query plan',
}: {
  open: boolean
  onClose: () => void
  connectionId: string
  /** The query to explain (NOT pre-wrapped — this builds the EXPLAIN). */
  sql: string
  title?: string
}) {
  const explainSql = sql.trim() ? buildExplainJsonSql(sql) : ''

  const plan = useQuery({
    queryKey: ['explain-plan', connectionId, explainSql],
    queryFn: () => runQuery(connectionId, explainSql),
    enabled: open && explainSql.length > 0,
    staleTime: 30_000,
    retry: false,
  })

  // The QUERY PLAN column holds the FORMAT JSON document; parseExplainPlan
  // tolerates the wrapper row, the bare array, or a JSON string.
  const firstRow = plan.data?.results[0]?.rows[0]
  const raw =
    firstRow && typeof firstRow === 'object' && 'QUERY PLAN' in firstRow
      ? (firstRow as Record<string, unknown>)['QUERY PLAN']
      : firstRow

  return (
    <Dialog open={open} onClose={onClose} title={title} className="max-w-4xl">
      <div className="flex h-[70vh] min-h-0 flex-col">
        {plan.isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loading>Planning query…</Loading>
          </div>
        )}
        {plan.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {(plan.error as Error).message}
          </div>
        )}
        {!plan.isLoading && !plan.error && raw != null && <ExplainPlan raw={raw} />}
      </div>
    </Dialog>
  )
}
