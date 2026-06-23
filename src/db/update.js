/**
 * Inline edit → parameterized UPDATE.
 *
 * Translates `{ where: { pk: value, ... }, set: { col: value, ... } }` into a
 * single parameterized statement of the form:
 *
 *   UPDATE "schema"."table"
 *   SET "col" = $1, "col2" = $2::jsonb, ...
 *   WHERE "pk1" = $n AND "pk2" = $n+1
 *   RETURNING *
 *
 * Rules:
 *   - The `where` keys MUST be exactly the table's primary-key columns (so a
 *     stale edit can never UPDATE more than one row).
 *   - The `set` keys must be known columns. Empty `set` is rejected.
 *   - json/jsonb values that arrive as objects/arrays get JSON.stringify'd and
 *     cast as `::json` / `::jsonb`; everything else rides through the driver's
 *     native type coercion.
 *
 * Identifier quoting goes through the shared escaper so mixed-case columns
 * work; user-supplied values never reach the SQL string.
 */

const { quoteIdent } = require('./identifier');

const MAX_SET_COLUMNS = 200;

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
 * @param {{ where: Record<string, unknown>, set: Record<string, unknown> }} spec
 * @param {Record<string, { dataType: string, isPrimaryKey: boolean, ... }>} columns
 * @param {string} qualifiedTable  pre-quoted "schema"."table"
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildUpdateRow(spec, columns, qualifiedTable) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Update payload must be an object');
  }
  const { where, set } = spec;
  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    throw new Error('`where` must be an object of primary-key columns');
  }
  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    throw new Error('`set` must be an object of column updates');
  }

  const pkCols = Object.keys(columns).filter((c) => columns[c].isPrimaryKey);
  if (pkCols.length === 0) {
    throw new Error('Table has no primary key — inline editing requires one');
  }

  const setKeys = Object.keys(set);
  if (setKeys.length === 0) {
    throw new Error('`set` must include at least one column');
  }
  if (setKeys.length > MAX_SET_COLUMNS) {
    throw new Error(`Cannot update more than ${MAX_SET_COLUMNS} columns at once`);
  }
  for (const k of setKeys) {
    if (!Object.prototype.hasOwnProperty.call(columns, k)) {
      throw new Error(`Unknown column: ${k}`);
    }
  }

  const whereKeys = Object.keys(where);
  // Allow PK columns in any order, but every PK must appear and no non-PK keys
  // are accepted — keeps the UPDATE pinned to exactly one row.
  for (const k of whereKeys) {
    if (!pkCols.includes(k)) {
      throw new Error(`\`where\` only accepts primary-key columns; got: ${k}`);
    }
  }
  if (whereKeys.length !== pkCols.length) {
    throw new Error(
      `\`where\` must include every primary-key column (${pkCols.join(', ')})`,
    );
  }

  const params = [];
  const setFragments = setKeys.map((k) => {
    const { fragment, params: added } = formatValue(set[k], columns[k], params.length);
    params.push(...added);
    return `${quoteIdent(k)} = ${fragment}`;
  });
  const whereFragments = pkCols.map((k) => {
    const { fragment, params: added } = formatValue(where[k], columns[k], params.length);
    params.push(...added);
    return `${quoteIdent(k)} = ${fragment}`;
  });

  return {
    sql:
      `UPDATE ${qualifiedTable} SET ${setFragments.join(', ')}` +
      ` WHERE ${whereFragments.join(' AND ')} RETURNING *`,
    params,
  };
}

module.exports = { buildUpdateRow, MAX_SET_COLUMNS };
