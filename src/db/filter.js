/**
 * Visual filter spec → parameterized WHERE clause.
 *
 * The UI sends a structured spec (never raw SQL fragments). We validate it
 * against the table's column metadata, then emit `WHERE ...` plus the
 * `$1, $2, ...` parameter array. The data and count queries reuse the
 * same params so a single bound array drives both.
 *
 * Spec shape (recursive):
 *   Group     = { type: 'group', combinator: 'and'|'or', children: [...] }
 *   Condition = { type: 'condition', column, op, value? }
 *
 * Supported operators (op → SQL fragment):
 *   eq, neq, gt, gte, lt, lte   = | <> | > | >= | < | <=
 *   like, ilike                  LIKE | ILIKE
 *   in, nin                     = ANY($) | <> ALL($)        value: non-empty array
 *   is_null, is_not_null         IS NULL | IS NOT NULL      (no value)
 *   jsonb_contains              @> $::jsonb                 (jsonb columns only)
 *   array_overlaps              && $                        (array columns only)
 */

const { z } = require('zod');
const { quoteIdent } = require('./identifier');

const OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'like', 'ilike', 'in', 'nin',
  'is_null', 'is_not_null',
  'jsonb_contains', 'array_overlaps',
]);
const VALUELESS_OPS = new Set(['is_null', 'is_not_null']);
const ARRAY_OPS = new Set(['in', 'nin', 'array_overlaps']);

const MAX_DEPTH = 5;
const MAX_CONDITIONS = 50;

const ConditionSchema = z.object({
  type: z.literal('condition'),
  column: z.string().min(1).max(255).refine(s => !s.includes('\0'), 'null byte'),
  op: z.string().refine(o => OPS.has(o), 'unknown operator'),
  value: z.unknown().optional(),
});

const GroupSchema = z.lazy(() => z.object({
  type: z.literal('group'),
  combinator: z.enum(['and', 'or']),
  children: z.array(z.union([ConditionSchema, GroupSchema])),
}));

const FilterSpecSchema = GroupSchema;

/**
 * @param {object} spec
 * @param {object} columnMetadata  shape from getTableMetadata().columns
 * @returns {{ sql: string, params: unknown[] }}  sql is empty when spec has no
 *   conditions; callers should not prepend "WHERE" in that case.
 */
function buildWhere(spec, columnMetadata) {
  if (spec == null) return { sql: '', params: [] };

  const parsed = FilterSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(`Invalid filter spec: ${parsed.error.issues[0]?.message ?? 'parse error'}`);
  }

  const state = { params: [], conditionCount: 0 };
  const inner = buildNode(parsed.data, columnMetadata, state, 0);
  if (!inner) return { sql: '', params: [] };
  return { sql: ` WHERE ${inner}`, params: state.params };
}

function buildNode(node, columns, state, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(`Filter nesting exceeds max depth of ${MAX_DEPTH}`);
  }
  if (node.type === 'group') {
    const parts = [];
    for (const child of node.children) {
      const piece = buildNode(child, columns, state, depth + 1);
      if (piece) parts.push(piece);
    }
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `(${parts.join(node.combinator === 'or' ? ' OR ' : ' AND ')})`;
  }
  return buildCondition(node, columns, state);
}

function buildCondition(node, columns, state) {
  state.conditionCount += 1;
  if (state.conditionCount > MAX_CONDITIONS) {
    throw new Error(`Filter exceeds max of ${MAX_CONDITIONS} conditions`);
  }

  const meta = columns[node.column];
  if (!meta) throw new Error(`Unknown column: ${node.column}`);

  const col = quoteIdent(node.column);
  const op = node.op;

  if (VALUELESS_OPS.has(op)) {
    return `${col} ${op === 'is_null' ? 'IS NULL' : 'IS NOT NULL'}`;
  }

  if (!Object.prototype.hasOwnProperty.call(node, 'value')) {
    throw new Error(`Operator ${op} requires a value`);
  }

  if (ARRAY_OPS.has(op)) {
    if (!Array.isArray(node.value) || node.value.length === 0) {
      throw new Error(`Operator ${op} requires a non-empty array`);
    }
  }

  if (op === 'like' || op === 'ilike') {
    if (typeof node.value !== 'string') {
      throw new Error(`${op} requires a string value`);
    }
  }

  if (op === 'jsonb_contains') {
    const t = (meta.dataType || '').toLowerCase();
    if (t !== 'jsonb' && t !== 'json') {
      throw new Error(`jsonb_contains is only valid on json/jsonb columns`);
    }
    const json = typeof node.value === 'string'
      ? node.value
      : JSON.stringify(node.value);
    state.params.push(json);
    return `${col} @> $${state.params.length}::jsonb`;
  }

  switch (op) {
    case 'eq':  state.params.push(node.value); return `${col} = $${state.params.length}`;
    case 'neq': state.params.push(node.value); return `${col} <> $${state.params.length}`;
    case 'gt':  state.params.push(node.value); return `${col} > $${state.params.length}`;
    case 'gte': state.params.push(node.value); return `${col} >= $${state.params.length}`;
    case 'lt':  state.params.push(node.value); return `${col} < $${state.params.length}`;
    case 'lte': state.params.push(node.value); return `${col} <= $${state.params.length}`;
    case 'like':  state.params.push(node.value); return `${col} LIKE $${state.params.length}`;
    case 'ilike': state.params.push(node.value); return `${col} ILIKE $${state.params.length}`;
    case 'in':  state.params.push(node.value); return `${col} = ANY($${state.params.length})`;
    case 'nin': state.params.push(node.value); return `${col} <> ALL($${state.params.length})`;
    case 'array_overlaps': state.params.push(node.value); return `${col} && $${state.params.length}`;
    default:
      // Schema validation already rejects unknown ops; this guards the switch.
      throw new Error(`Unhandled operator: ${op}`);
  }
}

module.exports = { buildWhere, FilterSpecSchema, MAX_DEPTH, MAX_CONDITIONS };
