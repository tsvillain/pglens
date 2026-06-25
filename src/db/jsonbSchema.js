/**
 * JSONB schema inference (roadmap §7.3).
 *
 * Sample N rows of a json/jsonb column and walk the parsed values in JS to infer
 * the set of paths, the types seen at each, how often each occurs, and one
 * sample value. The driver already parses jsonb into JS objects, so walking in
 * JS handles arbitrary nesting for free — far simpler (and more correct) than a
 * recursive catalog query.
 *
 * Object keys produce a filterable `path` (the `col #>> {path}` accessor the
 * path builder emits). Anything reached by descending into an array is shown
 * for orientation but not filterable, since array traversal isn't expressible
 * as a #>> path.
 *
 * ponytail: head sample (`LIMIT n`) — biased toward the table's physical start.
 * Swap in `TABLESAMPLE` if that bias ever bites on a real table.
 */

const { quoteIdent } = require('./identifier');

const MAX_PATHS = 300;          // cap output for pathological wide documents
const MAX_SAMPLE_LEN = 200;     // truncate long sample strings

function jsType(v) {
  if (v === null) return 'null';
  return typeof v; // 'string' | 'number' | 'boolean'
}

function record(paths, seen, display, accessor, type, sample) {
  let e = paths.get(display);
  if (!e) {
    if (paths.size >= MAX_PATHS) return;
    e = { display, accessor, types: new Set(), occ: 0, sample: undefined };
    paths.set(display, e);
  }
  e.types.add(type);
  if (e.sample === undefined && sample !== undefined && type !== 'null') {
    e.sample = typeof sample === 'string' && sample.length > MAX_SAMPLE_LEN
      ? sample.slice(0, MAX_SAMPLE_LEN) + '…'
      : sample;
  }
  if (!seen.has(display)) {
    e.occ += 1;
    seen.add(display);
  }
}

/**
 * Walk one JSON value.
 * @param accessor  object-key chain to here (null once an array was crossed —
 *                  the path is no longer a valid #>> accessor)
 * @param display   human path string, with `[]` marking array descents
 */
function visit(node, accessor, display, paths, seen) {
  if (Array.isArray(node)) {
    if (display) record(paths, seen, display, accessor, 'array', undefined);
    const childDisplay = display ? `${display}[]` : '[]';
    for (const el of node) visit(el, null, childDisplay, paths, seen);
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const seg = display ? `${display}.${k}` : k;
      visit(v, accessor ? [...accessor, k] : null, seg, paths, seen);
    }
  } else if (display) {
    record(paths, seen, display, accessor, jsType(node), node);
  }
}

/** Pure: infer the path map from already-fetched sample values. */
function inferFromValues(values) {
  const paths = new Map();
  for (const v of values) {
    visit(v, [], '', paths, new Set());
  }
  const total = values.length || 1;
  return [...paths.values()]
    .map((e) => ({
      path: e.display,
      accessor: e.accessor,            // string[] | null — null = not filterable
      types: [...e.types].sort(),
      occurrences: e.occ,
      frequency: e.occ / total,
      sample: e.sample ?? null,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.path.localeCompare(b.path));
}

/**
 * Sample a json/jsonb column and infer its shape.
 * @returns {Promise<{ column, sampleSize, sampledRows, paths }>}
 */
async function inferJsonbSchema(pool, qualifiedTable, column, columnMetadata, sampleSize) {
  const meta = columnMetadata[column];
  if (!meta) {
    const err = new Error(`Unknown column: ${column}`);
    err.statusCode = 400;
    throw err;
  }
  const t = (meta.dataType || '').toLowerCase();
  if (t !== 'jsonb' && t !== 'json') {
    const err = new Error(`Column "${column}" is ${meta.dataType}, not json/jsonb`);
    err.statusCode = 400;
    throw err;
  }

  const col = quoteIdent(column);
  const sql = `SELECT ${col} AS v FROM ${qualifiedTable} WHERE ${col} IS NOT NULL LIMIT $1`;
  const result = await pool.query(sql, [sampleSize]);
  // json columns may arrive as strings; jsonb arrives parsed.
  const values = result.rows.map((r) => {
    if (typeof r.v !== 'string') return r.v;
    try { return JSON.parse(r.v); } catch { return null; }
  });

  return {
    column,
    sampleSize,
    sampledRows: values.length,
    paths: inferFromValues(values),
  };
}

module.exports = { inferJsonbSchema, inferFromValues, MAX_PATHS };
