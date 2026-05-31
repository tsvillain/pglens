/**
 * Per-column aggregation helpers: which functions a column type supports, their
 * labels, value formatting, and a client-side mirror of the SELECT the server
 * builds (for the read-only "Show SQL" preview). The server is the source of
 * truth and re-derives everything; the preview never executes.
 */

import type { FilterGroup } from '@/lib/api'
import { previewWhere } from '@/lib/filterSql'

export type AggFn =
  | 'count'
  | 'count_distinct'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'stddev'
  | 'count_true'
  | 'count_false'

export const AGG_LABELS: Record<AggFn, string> = {
  count: 'Count',
  count_distinct: 'Count distinct',
  sum: 'Sum',
  avg: 'Avg',
  min: 'Min',
  max: 'Max',
  stddev: 'Std dev',
  count_true: 'Count true',
  count_false: 'Count false',
}

const NUMERIC = /(int|numeric|decimal|real|double|serial|money)/

/** Functions offered for a column, mirroring the server's type gating. */
export function aggsForType(dataType: string | undefined): AggFn[] {
  const t = (dataType ?? '').toLowerCase()
  if (t.includes('bool')) return ['count', 'count_distinct', 'count_true', 'count_false']
  if (NUMERIC.test(t)) return ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'stddev']
  return ['count', 'count_distinct', 'min', 'max']
}

/** SQL expression for one aggregate, used by the Show SQL preview only. */
export function aggExprSql(fn: AggFn, column: string): string {
  const col = `"${column}"`
  switch (fn) {
    case 'count': return `COUNT(${col})`
    case 'count_distinct': return `COUNT(DISTINCT ${col})`
    case 'sum': return `SUM(${col})`
    case 'avg': return `AVG(${col})`
    case 'min': return `MIN(${col})`
    case 'max': return `MAX(${col})`
    case 'stddev': return `STDDEV(${col})`
    case 'count_true': return `COUNT(*) FILTER (WHERE ${col} IS TRUE)`
    case 'count_false': return `COUNT(*) FILTER (WHERE ${col} IS FALSE)`
  }
}

/** Read-only preview of the aggregate query for the active columns + filter. */
export function previewAggregate(
  tableName: string,
  aggs: Array<{ column: string; fn: AggFn }>,
  filter: FilterGroup,
): string {
  if (aggs.length === 0) return ''
  const select = aggs
    .map((a) => `${aggExprSql(a.fn, a.column)} AS ${a.fn}_${a.column}`)
    .join(',\n       ')
  const where = previewWhere(filter)
  return `SELECT ${select}\n  FROM "${tableName}"${where ? `\n ${where}` : ''}`
}

/** Format an aggregate value for display. Numerics get thousands separators. */
export function formatAggValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const n = typeof value === 'number' ? value : Number(value)
  if (typeof value !== 'object' && value !== '' && Number.isFinite(n)) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  }
  return String(value)
}
