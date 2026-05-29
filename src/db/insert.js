/**
 * Row insert form → parameterized INSERT.
 *
 * Translates `{ values: { col: value, ... } }` into a single parameterized
 * statement of the form:
 *
 *   INSERT INTO "schema"."table" ("col", "col2")
 *   VALUES ($1, $2::jsonb)
 *   RETURNING *
 *
 * Rules:
 *   - Only columns present in `values` are written; every omitted column falls
 *     back to its DEFAULT (or NULL). This is how the form's "use default"
 *     affordance maps to SQL — the column simply isn't in the INSERT.
 *   - An empty `values` object emits `DEFAULT VALUES`, inserting a row that is
 *     entirely defaults (valid when every column is nullable or has a default).
 *   - `values` keys must be known columns; unknown columns 400.
 *   - json/jsonb values that arrive as objects/arrays get JSON.stringify'd and
 *     cast as `::json` / `::jsonb`; everything else rides through the driver's
 *     native type coercion. A SQL NULL is sent as a bare param (no cast) so the
 *     column is set to NULL rather than the JSON string "null".
 *
 * Identifier quoting goes through the shared escaper so mixed-case columns
 * work; user-supplied values never reach the SQL string. NOT NULL / CHECK /
 * unique violations are left for Postgres to raise — the route surfaces them
 * through the standard error envelope.
 */

const { quoteIdent } = require('./identifier');

// Postgres caps a table at 1600 columns; nothing valid can exceed that.
const MAX_INSERT_COLUMNS = 1600;

function formatValue(value, meta, baseIdx) {
  const type = (meta?.dataType || '').toLowerCase();
  if (value !== null && (type === 'jsonb' || type === 'json')) {
    // The driver doesn't auto-stringify objects for jsonb, so do it here and
    // cast explicitly. A pre-stringified value passes through unchanged.
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    return { fragment: `$${baseIdx + 1}::${type}`, params: [json] };
  }
  return { fragment: `$${baseIdx + 1}`, params: [value] };
}

/**
 * @param {{ values: Record<string, unknown> }} spec
 * @param {Record<string, { dataType: string, ... }>} columns
 * @param {string} qualifiedTable  pre-quoted "schema"."table"
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildInsertRow(spec, columns, qualifiedTable) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Insert payload must be an object');
  }
  const { values } = spec;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('`values` must be an object of column values');
  }

  const keys = Object.keys(values);
  if (keys.length > MAX_INSERT_COLUMNS) {
    throw new Error(`Cannot insert more than ${MAX_INSERT_COLUMNS} columns at once`);
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(columns, k)) {
      throw new Error(`Unknown column: ${k}`);
    }
  }

  // No columns supplied → every column takes its DEFAULT.
  if (keys.length === 0) {
    return {
      sql: `INSERT INTO ${qualifiedTable} DEFAULT VALUES RETURNING *`,
      params: [],
    };
  }

  const params = [];
  const colFragments = keys.map((k) => quoteIdent(k));
  const valFragments = keys.map((k) => {
    const { fragment, params: added } = formatValue(values[k], columns[k], params.length);
    params.push(...added);
    return fragment;
  });

  return {
    sql:
      `INSERT INTO ${qualifiedTable} (${colFragments.join(', ')})` +
      ` VALUES (${valFragments.join(', ')}) RETURNING *`,
    params,
  };
}

module.exports = { buildInsertRow, MAX_INSERT_COLUMNS };
