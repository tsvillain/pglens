/**
 * Client-side multi-column sort for an in-memory query result set (roadmap
 * §5.4 — the result grid reuses the no-code DataGrid, "inherits sorting").
 *
 * No-code table sorting is done server-side (it re-queries with ORDER BY), but
 * an Advanced-mode result is an arbitrary, already-fetched set with no table to
 * re-query, so the grid's sort is applied here over the rows in hand.
 */

import type { SortEntry } from '@/lib/api'

/**
 * Compare two non-null cell values: numbers numerically; booleans false < true;
 * everything else by locale-aware string compare (which also gives sensible ISO
 * date/timestamp ordering). Null handling lives in the sort loop so nulls can
 * stay last regardless of the column's direction.
 */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * Return a new array of `rows` sorted by `sort` (highest priority first).
 * Nulls/undefined always sort last (in both asc and desc). Stable: equal rows
 * keep their original order. Returns the input unchanged when there is nothing
 * to sort by.
 */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: SortEntry[],
): T[] {
  if (sort.length === 0) return rows
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      for (const { column, direction } of sort) {
        const a = x.row[column]
        const b = y.row[column]
        const aNil = a === null || a === undefined
        const bNil = b === null || b === undefined
        if (aNil && bNil) continue
        if (aNil) return 1 // nulls last, independent of direction
        if (bNil) return -1
        const cmp = compareValues(a, b)
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
      }
      return x.index - y.index
    })
    .map((entry) => entry.row)
}
