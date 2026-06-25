/**
 * Column classification + chart-type suggestion for the §7.5 chart panel.
 *
 * Given the columns of a result (each a Postgres type name from pgTypes, plus a
 * few sample values for when the type is unknown) it buckets every column into
 * numeric / temporal / categorical and proposes 2–3 chart types with sensible
 * default axes:
 *   - line    — temporal x + numeric y (time series)
 *   - bar     — categorical x + numeric y
 *   - scatter — numeric x + numeric y
 */

export type ColKind = 'numeric' | 'temporal' | 'categorical'
export type ChartType = 'line' | 'bar' | 'scatter'

export interface ChartColumn {
  name: string
  kind: ColKind
}

export interface ChartSuggestion {
  type: ChartType
  x: string
  y: string
  /** Human label, e.g. "Line · created_at × count". */
  label: string
}

type Row = Record<string, unknown>

const NUMERIC_TYPES = new Set([
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'numeric',
  'oid',
])
const TEMPORAL_TYPES = new Set([
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
])

/** First non-null value in a column, for type sniffing when the OID is unknown. */
function sampleValue(rows: Row[], name: string): unknown {
  for (const r of rows) {
    const v = r[name]
    if (v != null) return v
  }
  return null
}

/** Classify one column from its Postgres type name, falling back to its data. */
export function classifyColumn(
  type: string,
  rows: Row[],
  name: string,
): ColKind {
  if (NUMERIC_TYPES.has(type)) return 'numeric'
  if (TEMPORAL_TYPES.has(type)) return 'temporal'
  // A known non-number/date type (text, bool, uuid, …). `oid:NNNN` is pgTypes'
  // placeholder for an unrecognised OID, so it falls through to value sniffing.
  if (type && !type.startsWith('oid:')) return 'categorical'

  // Unknown type (oid:NNNN or empty) — sniff the first value.
  const v = sampleValue(rows, name)
  if (typeof v === 'number') return 'numeric'
  if (v instanceof Date) return 'temporal'
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return 'temporal'
  return 'categorical'
}

export function classifyColumns(
  columns: { name: string; type: string }[],
  rows: Row[],
): ChartColumn[] {
  return columns.map((c) => ({
    name: c.name,
    kind: classifyColumn(c.type, rows, c.name),
  }))
}

const TYPE_LABEL: Record<ChartType, string> = {
  line: 'Line',
  bar: 'Bar',
  scatter: 'Scatter',
}

function suggestion(type: ChartType, x: string, y: string): ChartSuggestion {
  return { type, x, y, label: `${TYPE_LABEL[type]} · ${x} × ${y}` }
}

/**
 * Propose chart types for a set of classified columns. Returns at most three,
 * ordered most-relevant first; empty when no numeric column exists to plot.
 */
export function suggestCharts(cols: ChartColumn[]): ChartSuggestion[] {
  const numeric = cols.filter((c) => c.kind === 'numeric')
  const temporal = cols.filter((c) => c.kind === 'temporal')
  const categorical = cols.filter((c) => c.kind === 'categorical')

  const out: ChartSuggestion[] = []
  if (temporal[0] && numeric[0]) {
    out.push(suggestion('line', temporal[0].name, numeric[0].name))
  }
  if (categorical[0] && numeric[0]) {
    out.push(suggestion('bar', categorical[0].name, numeric[0].name))
  }
  if (numeric[1]) {
    out.push(suggestion('scatter', numeric[0].name, numeric[1].name))
  }
  // Fallback: a single numeric column still charts as a bar over row index.
  if (out.length === 0 && numeric[0]) {
    const x = cols.find((c) => c.kind !== 'numeric')?.name ?? numeric[0].name
    out.push(suggestion('bar', x, numeric[0].name))
  }
  return out
}
