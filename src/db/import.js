/**
 * Per-table CSV import → parameterized multi-row INSERT.
 *
 * Translates a block of already-parsed CSV rows (the client parses the file
 * and projects each row to the target columns the user mapped) into a single
 * parameterized statement of the form:
 *
 *   INSERT INTO "schema"."table" ("a", "b")
 *   VALUES ($1, $2::jsonb), ($3, $4::jsonb), ...
 *   ON CONFLICT (...) DO UPDATE SET ...
 *   RETURNING (xmax = 0) AS pglens_inserted
 *
 * Three conflict modes mirror the roadmap's import wizard:
 *   - `insert` : plain INSERT. Any unique/PK collision aborts the statement
 *                (and, in the route, the surrounding transaction).
 *   - `skip`   : INSERT ... ON CONFLICT DO NOTHING. Colliding rows are dropped.
 *   - `update` : INSERT ... ON CONFLICT (<conflict cols>) DO UPDATE SET ...
 *                Colliding rows overwrite the matched row's non-key columns.
 *
 * The `RETURNING (xmax = 0)` flag is the standard Postgres idiom for telling an
 * inserted row (system xmax 0) apart from one the upsert updated, so the route
 * can report inserted-vs-updated counts. Rows that DO NOTHING skips are simply
 * absent from RETURNING — `attempted - returned` is the conflict count.
 *
 * Identifiers go through the shared escaper; cell values never reach the SQL
 * string — they ride the driver as bound parameters.
 */

const { quoteIdent } = require('./identifier');

const IMPORT_MODES = ['insert', 'skip', 'update'];

// Postgres caps a single bound statement at 65535 parameters. The route splits
// rows into batches so `batchRows * columns` stays under this; the builder
// itself just enforces the hard ceiling as a guard.
const MAX_BOUND_PARAMS = 65535;

/** Per-column cast suffix. Only json/jsonb need an explicit cast; the driver
 * infers everything else from the target column's type. */
function columnCast(meta) {
  const t = (meta?.dataType || '').toLowerCase();
  if (t === 'jsonb' || t === 'json') return `::${t}`;
  return '';
}

/**
 * Normalize one raw CSV cell to the value bound for its column.
 *   - `null`/`undefined` → SQL NULL.
 *   - empty string → NULL when `emptyAsNull` (the import default), so blank
 *     cells don't fail NOT-NULL-less numeric/date columns; otherwise the empty
 *     string passes through (meaningful for text columns).
 *   - everything else passes through as the parsed string; Postgres casts it to
 *     the column type via the INSERT's target-column context.
 */
function coerceCell(raw, emptyAsNull) {
  if (raw === null || raw === undefined) return null;
  if (raw === '' && emptyAsNull) return null;
  return raw;
}

/**
 * @param {object}   opts
 * @param {string}   opts.qualifiedTable  pre-quoted "schema"."table"
 * @param {string[]} opts.targetColumns   ordered target column names
 * @param {Record<string, { dataType: string }>} opts.columnMeta
 * @param {Array<Array<unknown>>} opts.rows  cells aligned to targetColumns
 * @param {'insert'|'skip'|'update'} opts.mode
 * @param {string[]} [opts.conflictColumns] required for `update`
 * @param {boolean}  [opts.emptyAsNull=true]
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildImportStatement(opts) {
  const {
    qualifiedTable, targetColumns, columnMeta, rows, mode,
    conflictColumns = [], emptyAsNull = true,
  } = opts;

  if (!IMPORT_MODES.includes(mode)) {
    throw new Error(`Unknown import mode: ${mode}`);
  }
  if (!Array.isArray(targetColumns) || targetColumns.length === 0) {
    throw new Error('At least one target column is required');
  }
  if (new Set(targetColumns).size !== targetColumns.length) {
    throw new Error('Duplicate target column in mapping');
  }
  for (const c of targetColumns) {
    if (!Object.prototype.hasOwnProperty.call(columnMeta, c)) {
      throw new Error(`Unknown column: ${c}`);
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No rows to import');
  }
  if (rows.length * targetColumns.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `Batch of ${rows.length} rows × ${targetColumns.length} columns exceeds the ${MAX_BOUND_PARAMS}-parameter limit`,
    );
  }

  const colIdents = targetColumns.map(quoteIdent);
  const casts = targetColumns.map((c) => columnCast(columnMeta[c]));

  const params = [];
  const tuples = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== targetColumns.length) {
      throw new Error(
        `Row has ${Array.isArray(row) ? row.length : 'non-array'} cells, expected ${targetColumns.length}`,
      );
    }
    const placeholders = targetColumns.map((_, i) => {
      params.push(coerceCell(row[i], emptyAsNull));
      return `$${params.length}${casts[i]}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  let conflict = '';
  if (mode === 'skip') {
    conflict = ' ON CONFLICT DO NOTHING';
  } else if (mode === 'update') {
    if (!Array.isArray(conflictColumns) || conflictColumns.length === 0) {
      throw new Error('Update mode requires at least one conflict column');
    }
    for (const c of conflictColumns) {
      if (!targetColumns.includes(c)) {
        throw new Error(`Conflict column "${c}" must be one of the mapped columns`);
      }
    }
    const updateCols = targetColumns.filter((c) => !conflictColumns.includes(c));
    const target = conflictColumns.map(quoteIdent).join(', ');
    if (updateCols.length === 0) {
      // Nothing to overwrite (only key columns mapped) — degrade to a skip so
      // the statement stays valid instead of `DO UPDATE SET` with no columns.
      conflict = ` ON CONFLICT (${target}) DO NOTHING`;
    } else {
      const setList = updateCols
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(', ');
      conflict = ` ON CONFLICT (${target}) DO UPDATE SET ${setList}`;
    }
  }

  const sql =
    `INSERT INTO ${qualifiedTable} (${colIdents.join(', ')})` +
    ` VALUES ${tuples.join(', ')}${conflict}` +
    ` RETURNING (xmax = 0) AS pglens_inserted`;

  return { sql, params };
}

/** Largest row count that keeps `rows * columns` under the bound-param limit,
 * leaving headroom. Used by the route to split a big import into statements. */
function batchSizeFor(columnCount) {
  if (columnCount <= 0) return 1;
  return Math.max(1, Math.floor(MAX_BOUND_PARAMS / columnCount));
}

module.exports = {
  IMPORT_MODES,
  MAX_BOUND_PARAMS,
  buildImportStatement,
  batchSizeFor,
  // exported for unit tests
  coerceCell,
  columnCast,
};
