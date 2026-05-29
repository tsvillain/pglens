/**
 * Per-column aggregations against the current filter.
 *
 * The UI sends a spec (never raw SQL): an array of { column, fn }. We validate
 * each column against the table metadata and each function against the column's
 * type, quote identifiers, and run a single one-row SELECT that reuses the same
 * `WHERE` + params as the data read. Counts come back as strings (bigint) and
 * numeric aggregates may come back as strings (numeric); the client formats.
 *
 * Allowed functions by column kind (roadmap §4.7):
 *   numeric      count, count_distinct, sum, avg, min, max, stddev
 *   text/date    count, count_distinct, min, max
 *   boolean      count, count_distinct, count_true, count_false
 */

const { z } = require('zod');
const { getPool } = require('./connection');
const { quoteIdent } = require('./identifier');

const NUMERIC_FNS = new Set(['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'stddev']);
const TEXT_DATE_FNS = new Set(['count', 'count_distinct', 'min', 'max']);
const BOOLEAN_FNS = new Set(['count', 'count_distinct', 'count_true', 'count_false']);
const ALL_FNS = new Set([...NUMERIC_FNS, ...TEXT_DATE_FNS, ...BOOLEAN_FNS]);

const MAX_AGGS = 100;

const NUMERIC_RE = /(int|numeric|decimal|real|double|serial|money)/;

const AggItemSchema = z.object({
  column: z.string().min(1).max(255).refine((s) => !s.includes('\0'), 'null byte'),
  fn: z.string().refine((f) => ALL_FNS.has(f), 'unknown aggregate function'),
});

const AggregateSpecSchema = z.array(AggItemSchema).max(MAX_AGGS);

/** Bucket a column's data_type into the kind that gates which functions apply. */
function columnKind(dataType) {
  const t = (dataType || '').toLowerCase();
  if (t.includes('bool')) return 'boolean';
  if (NUMERIC_RE.test(t)) return 'numeric';
  return 'other';
}

function allowedFns(kind) {
  if (kind === 'numeric') return NUMERIC_FNS;
  if (kind === 'boolean') return BOOLEAN_FNS;
  return TEXT_DATE_FNS;
}

/** SQL expression for one aggregate. `col` is already quoted. */
function aggExpr(fn, col) {
  switch (fn) {
    case 'count': return `COUNT(${col})`;
    case 'count_distinct': return `COUNT(DISTINCT ${col})`;
    case 'sum': return `SUM(${col})`;
    case 'avg': return `AVG(${col})`;
    case 'min': return `MIN(${col})`;
    case 'max': return `MAX(${col})`;
    case 'stddev': return `STDDEV(${col})`;
    case 'count_true': return `COUNT(*) FILTER (WHERE ${col} IS TRUE)`;
    case 'count_false': return `COUNT(*) FILTER (WHERE ${col} IS FALSE)`;
    default:
      // Schema validation already rejects unknown fns; this guards the switch.
      throw new Error(`Unhandled aggregate function: ${fn}`);
  }
}

/**
 * Validate the spec against the table's columns and build the SELECT list. Each
 * item becomes `<expr> AS a<i>` so results map back by index. Throws a 400 on an
 * unknown column or a function the column's type doesn't support.
 *
 * @returns {{ items: Array<{column,fn}>, selectSql: string }}  selectSql is
 *   empty when there are no items; callers should short-circuit in that case.
 */
function buildAggregateSelect(aggs, columnMetadata) {
  if (aggs == null) return { items: [], selectSql: '' };

  const parsed = AggregateSpecSchema.safeParse(aggs);
  if (!parsed.success) {
    const err = new Error(`Invalid aggregate spec: ${parsed.error.issues[0]?.message ?? 'parse error'}`);
    err.statusCode = 400;
    throw err;
  }
  const items = parsed.data;
  if (items.length === 0) return { items: [], selectSql: '' };

  const selects = items.map((item, i) => {
    const meta = columnMetadata[item.column];
    if (!meta) {
      const err = new Error(`Unknown column: ${item.column}`);
      err.statusCode = 400;
      throw err;
    }
    const kind = columnKind(meta.dataType);
    if (!allowedFns(kind).has(item.fn)) {
      const err = new Error(`${item.fn} is not valid on ${meta.dataType} column "${item.column}"`);
      err.statusCode = 400;
      throw err;
    }
    return `${aggExpr(item.fn, quoteIdent(item.column))} AS a${i}`;
  });

  return { items, selectSql: selects.join(', ') };
}

/**
 * Validate + run the aggregate spec. `whereSql`/`params` come from buildWhere so
 * aggregations honor the active filter. Returns one result per requested item,
 * in request order.
 *
 * @returns {Promise<{ results: Array<{ column: string, fn: string, value: unknown }> }>}
 */
async function computeAggregates(connectionId, qualifiedTable, { aggs, columnMetadata, whereSql, params }) {
  const { items, selectSql } = buildAggregateSelect(aggs, columnMetadata);
  if (items.length === 0) return { results: [] };

  const pool = getPool(connectionId);
  const sql = `SELECT ${selectSql} FROM ${qualifiedTable}${whereSql}`;
  const result = await pool.query(sql, params);
  const row = result.rows[0] ?? {};

  return {
    results: items.map((item, i) => ({
      column: item.column,
      fn: item.fn,
      value: row[`a${i}`] ?? null,
    })),
  };
}

module.exports = { computeAggregates, buildAggregateSelect, AggregateSpecSchema, MAX_AGGS };
