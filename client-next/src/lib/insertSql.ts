import type { ColumnMeta } from '@/lib/api'

/**
 * Render an insert spec as a human-readable INSERT for the "Show SQL"
 * disclosure. Mirrors src/db/insert.js but inlines values for display only —
 * the server uses parameter binding, never string interpolation.
 *
 * Only columns present in `values` appear; omitted columns take their DEFAULT
 * server-side, so an empty object renders `DEFAULT VALUES`.
 */
export function previewInsert(
  tableName: string,
  values: Record<string, unknown>,
  columns: Record<string, ColumnMeta>,
): string {
  const keys = Object.keys(values)
  if (keys.length === 0) {
    return `INSERT INTO ${quoteIdent(tableName)} DEFAULT VALUES`
  }
  const cols = keys.map(quoteIdent).join(', ')
  const vals = keys.map((k) => literal(values[k], columns[k])).join(', ')
  return `INSERT INTO ${quoteIdent(tableName)} (${cols})\nVALUES (${vals})`
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function literal(v: unknown, meta: ColumnMeta | undefined): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const t = (meta?.dataType ?? '').toLowerCase()
  if (t === 'json' || t === 'jsonb') {
    const json = typeof v === 'string' ? v : JSON.stringify(v)
    return `'${json.replaceAll("'", "''")}'::${t}`
  }
  return `'${String(v).replaceAll("'", "''")}'`
}
