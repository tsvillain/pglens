import type { FilterCondition, FilterGroup, FilterOp } from '@/lib/api'

/**
 * Render a filter spec as a human-readable WHERE clause for the "Show SQL"
 * disclosure. This mirrors src/db/filter.js but inlines values for display
 * only — the server uses parameter binding, never string interpolation.
 */
export function previewWhere(filter: FilterGroup | null): string {
  if (!filter || filter.children.length === 0) return ''
  const inner = renderNode(filter)
  return inner ? `WHERE ${inner}` : ''
}

function renderNode(node: FilterCondition | FilterGroup): string {
  if (node.type === 'group') {
    const parts = node.children.map(renderNode).filter(Boolean)
    if (parts.length === 0) return ''
    if (parts.length === 1) return parts[0]
    return `(${parts.join(node.combinator === 'or' ? ' OR ' : ' AND ')})`
  }
  return renderCondition(node)
}

function renderCondition(c: FilterCondition): string {
  // Path conditions read the text at `col->'a'->>'b'`; everything else operates
  // on the bare column. (Display form — the server uses `#>>` with bound params.)
  const col = c.path && c.path.length ? jsonbAccessor(c.column, c.path) : quoteIdent(c.column)
  switch (c.op) {
    case 'is_null': return `${col} IS NULL`
    case 'is_not_null': return `${col} IS NOT NULL`
    case 'eq':  return `${col} = ${literal(c.value)}`
    case 'neq': return `${col} <> ${literal(c.value)}`
    case 'gt':  return `${col} > ${literal(c.value)}`
    case 'gte': return `${col} >= ${literal(c.value)}`
    case 'lt':  return `${col} < ${literal(c.value)}`
    case 'lte': return `${col} <= ${literal(c.value)}`
    case 'like':  return `${col} LIKE ${literal(c.value)}`
    case 'ilike': return `${col} ILIKE ${literal(c.value)}`
    case 'in':  return `${col} IN (${arrayLiteral(c.value)})`
    case 'nin': return `${col} NOT IN (${arrayLiteral(c.value)})`
    case 'jsonb_contains': return `${col} @> ${jsonbLiteral(c.value)}`
    case 'has_key': return `jsonb_exists(${quoteIdent(c.column)}, ${literal(c.value)})`
    case 'array_overlaps': return `${col} && ARRAY[${arrayLiteral(c.value)}]`
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** `"col"->'a'->>'b'` for a JSONB key path — matches the roadmap's accessor form. */
export function jsonbAccessor(column: string, path: string[]): string {
  const col = quoteIdent(column)
  if (path.length === 0) return col
  const hops = path.map((k, i) => {
    const key = `'${k.replaceAll("'", "''")}'`
    return i === path.length - 1 ? `->>${key}` : `->${key}`
  })
  return col + hops.join('')
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return `'${String(v).replaceAll("'", "''")}'`
}

function arrayLiteral(v: unknown): string {
  if (!Array.isArray(v)) return ''
  return v.map(literal).join(', ')
}

function jsonbLiteral(v: unknown): string {
  const json = typeof v === 'string' ? v : JSON.stringify(v)
  return `'${json.replaceAll("'", "''")}'::jsonb`
}

export const OPERATOR_LABELS: Record<FilterOp, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  like: 'LIKE',
  ilike: 'ILIKE',
  in: 'IN',
  nin: 'NOT IN',
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
  jsonb_contains: '@>',
  has_key: 'has key',
  array_overlaps: '&&',
}

/**
 * Operators valid for a given Postgres data type. Returned in display order.
 */
export function operatorsForType(dataType: string | undefined): FilterOp[] {
  const t = (dataType ?? '').toLowerCase()
  const isBool = t === 'boolean' || t === 'bool'
  const isNumeric = /(^|\s)(smallint|integer|bigint|numeric|decimal|real|double precision|serial|bigserial)/.test(t)
  const isText = t === 'text' || t.startsWith('character') || t.startsWith('varchar') || t === 'citext'
  const isDateish = t === 'date' || t.startsWith('timestamp') || t.startsWith('time')
  const isJson = t === 'json' || t === 'jsonb'
  const isArray = t.endsWith('[]') || t.startsWith('_')

  const base: FilterOp[] = ['eq', 'neq', 'is_null', 'is_not_null']
  if (isBool) return ['eq', 'neq', 'is_null', 'is_not_null']
  if (isNumeric || isDateish) return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'is_null', 'is_not_null']
  if (isText) return ['eq', 'neq', 'like', 'ilike', 'in', 'nin', 'is_null', 'is_not_null']
  if (isJson) return ['jsonb_contains', 'has_key', 'is_null', 'is_not_null']
  if (isArray) return ['array_overlaps', 'is_null', 'is_not_null']
  return [...base, 'gt', 'gte', 'lt', 'lte', 'in', 'nin']
}

/** Operators a JSONB path condition (text extracted via `#>>`) may use. */
export const PATH_OPERATORS: FilterOp[] = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is_null', 'is_not_null',
]

export function opNeedsValue(op: FilterOp): boolean {
  return op !== 'is_null' && op !== 'is_not_null'
}

export function opTakesArray(op: FilterOp): boolean {
  return op === 'in' || op === 'nin' || op === 'array_overlaps'
}
