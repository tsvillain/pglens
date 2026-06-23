/**
 * Build the SELECT the no-code grid is about to run, used to seed the
 * Advanced-mode editor (roadmap §5.1). Mirrors the server read: filter →
 * WHERE, sort → ORDER BY, page/limit → LIMIT/OFFSET. Display-only — the
 * server re-parameterizes on execute, never string-interpolates.
 */

import type { FilterGroup, SortEntry } from '@/lib/api'
import { previewWhere } from '@/lib/filterSql'

export interface TableSelectSpec {
  tableName: string
  filter?: FilterGroup | null
  sort?: SortEntry[] | null
  limit?: number
  page?: number
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function buildTableSelect(spec: TableSelectSpec): string {
  const lines = ['SELECT *', `  FROM ${quoteIdent(spec.tableName)}`]

  const where = spec.filter ? previewWhere(spec.filter) : ''
  if (where) lines.push(` ${where}`)

  const sort = (spec.sort ?? []).filter((s) => s.column)
  if (sort.length > 0) {
    const cols = sort
      .map((s) => `${quoteIdent(s.column)} ${s.direction.toUpperCase()}`)
      .join(', ')
    lines.push(` ORDER BY ${cols}`)
  }

  const limit = spec.limit ?? 100
  const page = Math.max(1, spec.page ?? 1)
  const offset = (page - 1) * limit
  lines.push(` LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ''}`)

  return lines.join('\n') + ';'
}
