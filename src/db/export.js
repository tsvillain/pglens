/**
 * Per-table data export serializers.
 *
 * Pure, streaming-friendly formatters for CSV / JSON / SQL `INSERT` output.
 * A serializer is a small object with `head()`, `row(rowObj)`, and `foot()`
 * methods that each return a string chunk. The route writes those chunks
 * straight to the HTTP response as cursor batches arrive, so no format buffers
 * the full result set.
 *
 * Identifiers are pre-quoted by the caller's column list; these functions only
 * format *values*, and never interpolate user-supplied SQL.
 */

const { quoteIdent } = require('./identifier');

const EXPORT_FORMATS = ['csv', 'json', 'sql'];

const FORMAT_META = {
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv' },
  json: { contentType: 'application/json; charset=utf-8', extension: 'json' },
  sql: { contentType: 'application/sql; charset=utf-8', extension: 'sql' },
};

// ---- CSV (RFC 4180) ---------------------------------------------------------

/** Stringify a value for a CSV cell (pre-quoting). null/undefined → empty. */
function csvScalar(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Quote a CSV field only when it contains a delimiter, quote, or newline. */
function csvField(value) {
  const s = csvScalar(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function csvRow(columns, row) {
  return columns.map((c) => csvField(row[c])).join(',') + '\r\n';
}

// ---- SQL INSERT -------------------------------------------------------------

/** Render a value as a SQL literal. Mirrors the logical-dump formatter. */
function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) {
    const arr = value
      .map((v) =>
        v === null ? 'NULL'
          : typeof v === 'string' ? `"${v.replaceAll('"', '""')}"`
            : String(v),
      )
      .join(',');
    return `'{${arr}}'`;
  }
  if (typeof value === 'object') return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

// ---- Serializer factory -----------------------------------------------------

/**
 * @param {'csv'|'json'|'sql'} format
 * @param {object} opts
 * @param {string[]} opts.columns   Ordered column names to emit.
 * @param {string}   opts.tableName Bare table name (for SQL `INSERT INTO`).
 * @returns {{ head(): string, row(rowObj: object): string, foot(): string }}
 */
function createSerializer(format, { columns, tableName }) {
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }

  if (format === 'csv') {
    return {
      head: () => columns.map(csvField).join(',') + '\r\n',
      row: (rowObj) => csvRow(columns, rowObj),
      foot: () => '',
    };
  }

  if (format === 'json') {
    let first = true;
    return {
      head: () => '[',
      row: (rowObj) => {
        // Project to the chosen columns in order so JSON matches CSV/SQL.
        const projected = {};
        for (const c of columns) projected[c] = rowObj[c];
        const prefix = first ? '\n  ' : ',\n  ';
        first = false;
        return prefix + JSON.stringify(projected);
      },
      foot: () => (first ? ']\n' : '\n]\n'),
    };
  }

  // sql
  const target = quoteIdent(tableName);
  const colList = columns.map(quoteIdent).join(', ');
  return {
    head: () => `-- pglens data export for ${target}\n\n`,
    row: (rowObj) => {
      const values = columns.map((c) => sqlLiteral(rowObj[c])).join(', ');
      return `INSERT INTO ${target} (${colList}) VALUES (${values});\n`;
    },
    foot: () => '',
  };
}

module.exports = {
  EXPORT_FORMATS,
  FORMAT_META,
  createSerializer,
  // exported for unit tests
  csvField,
  sqlLiteral,
};
