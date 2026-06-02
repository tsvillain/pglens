/**
 * API Routes
 *
 * All routes use:
 *   - Zod request validation (body/query/params)
 *   - The standard error envelope from ../http/errors
 *   - The proper Postgres identifier escaper from ../db/identifier
 */

const express = require('express');
const { z } = require('zod');

const {
  getPool, createPool, closePool, checkConnection, getConnections,
  getConnectionSchema, updateConnectionSchema, updateConnection,
} = require('../db/connection');
const { quoteIdent, quoteQualifiedIdent } = require('../db/identifier');
const { buildWhere } = require('../db/filter');
const { buildOrderBy } = require('../db/sort');
const { computeAggregates } = require('../db/aggregate');
const { buildUpdateRow } = require('../db/update');
const { buildInsertRow } = require('../db/insert');
const { EXPORT_FORMATS, FORMAT_META, createSerializer, sqlLiteral } = require('../db/export');
const { IMPORT_MODES, buildImportStatement, batchSizeFor } = require('../db/import');
const { txManager } = require('../db/tx');
const views = require('../db/views');
const { sendError, codes } = require('../http/errors');
const { validate } = require('../http/validate');
const logger = require('../log');
const { format: formatPgSql } = require('sql-formatter');

const router = express.Router();

// ---- Shared schemas --------------------------------------------------------

const SslModeSchema = z.enum(['prefer', 'require', 'disable', 'verify-ca', 'verify-full']);
const SchemaNameSchema = z.string().min(1).max(255).refine(s => !s.includes('\0'), 'null byte');
const TableNameSchema = z.string().min(1).max(255).refine(s => !s.includes('\0'), 'null byte');

const ConnectBodySchema = z.object({
  url: z.string().min(1),
  sslMode: SslModeSchema.optional(),
  name: z.string().optional(),
  schema: SchemaNameSchema.optional(),
});

const ConnectionIdParam = z.object({ id: z.string().min(1) });

const TableListQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  cursor: z.union([z.string(), z.number()]).optional(),
  sortColumn: z.string().min(1).optional(),
  sortDirection: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
  // JSON-encoded multi-column sort spec (validated structurally by buildOrderBy).
  // Wins over legacy sortColumn/sortDirection when both are sent.
  sort: z.string().max(8_000).optional(),
  // JSON-encoded filter spec (validated structurally by buildWhere).
  filter: z.string().max(64_000).optional(),
});

const QueryBodySchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

const FormatBodySchema = z.object({
  sql: z.string().min(1).max(1_000_000),
});

// ---- requireConnection middleware ------------------------------------------

const requireConnection = (req, res, next) => {
  const connectionId = req.headers['x-connection-id'] || req.query.connectionId;
  if (!connectionId) {
    return sendError(res, 400, codes.BAD_REQUEST, 'Connection ID required', {
      hint: 'Send x-connection-id header or ?connectionId query param.',
    });
  }
  const pool = getPool(connectionId);
  if (!pool) {
    return sendError(res, 503, codes.NO_CONNECTION,
      'Not connected to database or invalid connection ID');
  }
  req.pool = pool;
  req.connectionId = connectionId;
  const schema = getConnectionSchema(connectionId);
  if (!schema || schema.includes('\0')) {
    return sendError(res, 400, codes.BAD_REQUEST, 'Connection has an invalid schema name');
  }
  req.schema = schema;
  next();
};

// ---- Connect / disconnect / status -----------------------------------------

router.post('/connect', validate({ body: ConnectBodySchema }), async (req, res) => {
  const { url, sslMode, name, schema } = req.body;
  try {
    const result = await createPool(url, sslMode || 'prefer', name, schema || 'public');
    res.json({ connected: true, connectionId: result.id, name: result.name });
  } catch (err) {
    return sendError(res, 400, codes.DB_ERROR, err.message, { hint: err.sslHint });
  }
});

router.put('/connections/:id',
  validate({ params: ConnectionIdParam, body: ConnectBodySchema }),
  async (req, res) => {
    try {
      const result = await updateConnection(
        req.params.id, req.body.url,
        req.body.sslMode || 'prefer', req.body.name,
        req.body.schema || 'public',
      );
      res.json({ updated: true, connectionId: req.params.id, name: result.name });
    } catch (err) {
      return sendError(res, 400, codes.DB_ERROR, err.message);
    }
  });

router.get('/connections', (req, res) => {
  res.json({ connections: getConnections() });
});

router.post('/disconnect', async (req, res) => {
  const connectionId = req.body?.connectionId || req.headers['x-connection-id'];
  if (!connectionId) {
    return sendError(res, 400, codes.BAD_REQUEST, 'Connection ID required');
  }
  try {
    await closePool(connectionId);
    invalidateMetadata(connectionId);
    res.json({ connected: false });
  } catch (err) {
    return sendError(res, 500, codes.INTERNAL, err.message);
  }
});

router.get('/status', async (req, res) => {
  const connectionId = req.headers['x-connection-id'];
  if (!connectionId) return res.json({ connected: false });
  try {
    res.json({ connected: await checkConnection(connectionId) });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ---- Schemas / tables -------------------------------------------------------

router.get('/schemas', requireConnection, async (req, res) => {
  try {
    const result = await req.pool.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      ORDER BY schema_name;
    `);
    res.json({ schemas: result.rows.map(r => r.schema_name) });
  } catch (err) {
    logger.error({ err: err.message }, 'list schemas failed');
    return sendError(res, 500, codes.DB_ERROR, err.message);
  }
});

router.get('/tables', requireConnection, async (req, res) => {
  try {
    const result = await req.pool.query(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name;
    `, [req.schema]);
    res.json({
      tables: result.rows.map(r => ({
        name: r.table_name,
        type: r.table_type === 'VIEW' ? 'view' : 'table',
      })),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'list tables failed');
    return sendError(res, 500, codes.DB_ERROR, err.message);
  }
});

// ---- Table-introspection helpers -------------------------------------------

async function getPrimaryKeyColumns(pool, tableName, schema) {
  const r = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_name = $1 AND tc.table_schema = $2;
  `, [tableName, schema]);
  return new Set(r.rows.map(x => x.column_name));
}

async function getUniqueColumns(pool, tableName, schema) {
  const r = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE'
      AND tc.table_name = $1 AND tc.table_schema = $2;
  `, [tableName, schema]);
  return new Set(r.rows.map(x => x.column_name));
}

async function getForeignKeyRelations(pool, tableName, schema) {
  const r = await pool.query(`
    SELECT kcu.column_name,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = $1 AND tc.table_schema = $2;
  `, [tableName, schema]);
  const out = {};
  for (const row of r.rows) {
    out[row.column_name] = { table: row.foreign_table_name, column: row.foreign_column_name };
  }
  return out;
}

async function getColumnMetadata(pool, tableName, schema) {
  const r = await pool.query(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = $2 AND table_name = $1
    ORDER BY ordinal_position;
  `, [tableName, schema]);

  const [pkCols, fkRels, uqCols] = await Promise.all([
    getPrimaryKeyColumns(pool, tableName, schema),
    getForeignKeyRelations(pool, tableName, schema),
    getUniqueColumns(pool, tableName, schema),
  ]);

  const out = {};
  for (const row of r.rows) {
    // `data_type` is the SQL standard name (e.g. "ARRAY", "USER-DEFINED").
    // Surface the real Postgres type (`udt_name`, e.g. `int4`, `text`,
    // `_text`, the enum name) so the editor can pick the right widget for
    // arrays and enums.
    out[row.column_name] = {
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null,
      // Raw default expression (e.g. `nextval('seq')`, `now()`, `'active'::text`).
      // The insert form ghosts this so the user knows what they're skipping.
      defaultValue: row.column_default,
      isPrimaryKey: pkCols.has(row.column_name),
      isForeignKey: !!fkRels[row.column_name],
      foreignKeyRef: fkRels[row.column_name] || null,
      isUnique: uqCols.has(row.column_name),
    };
  }
  return out;
}

/**
 * Column metadata is static between schema changes but costs ~3 catalog
 * round-trips to fetch — expensive on remote DBs. Cache it per
 * (connection, schema, table) with a short TTL so pagination/sort within a
 * table doesn't re-run the introspection queries on every page.
 */
const META_TTL_MS = 30_000;
const metaCache = new Map(); // key -> { expires, columns, primaryKeyColumn }

function invalidateMetadata(connectionId) {
  const prefix = `${connectionId}\0`;
  for (const key of metaCache.keys()) {
    if (key.startsWith(prefix)) metaCache.delete(key);
  }
}

async function getTableMetadata(pool, connectionId, schema, tableName) {
  const key = `${connectionId}\0${schema}\0${tableName}`;
  const hit = metaCache.get(key);
  if (hit && hit.expires > Date.now()) return hit;

  const columns = await getColumnMetadata(pool, tableName, schema);
  // First primary-key column (ordinal order preserved) drives ordering/cursor.
  const primaryKeyColumn =
    Object.keys(columns).find((name) => columns[name].isPrimaryKey) || null;

  const entry = { expires: Date.now() + META_TTL_MS, columns, primaryKeyColumn };
  metaCache.set(key, entry);
  return entry;
}

// ---- Table data -------------------------------------------------------------

router.get('/tables/:tableName',
  requireConnection,
  validate({
    params: z.object({ tableName: TableNameSchema }),
    query: TableListQuery,
  }),
  async (req, res) => {
    try {
      const tableName = req.params.tableName;
      const page = req.query.page || 1;
      const limit = req.query.limit || 100;
      const cursor = req.query.cursor;

      const pool = req.pool;
      const schema = req.schema;
      const qualifiedTable = quoteQualifiedIdent(schema, tableName);

      const { columns: columnMetadata, primaryKeyColumn } =
        await getTableMetadata(pool, req.connectionId, schema, tableName);

      // Resolve the user sort spec. Prefer the structured `sort` array; fall
      // back to legacy single-column `sortColumn`/`sortDirection` for the v2
      // client and older v3 builds.
      let sortSpec = null;
      if (req.query.sort) {
        try {
          sortSpec = JSON.parse(req.query.sort);
        } catch {
          return sendError(res, 400, codes.BAD_REQUEST, 'Invalid sort JSON');
        }
      } else if (req.query.sortColumn) {
        sortSpec = [{
          column: req.query.sortColumn,
          direction: (req.query.sortDirection || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
        }];
      }
      const hasUserSort = Array.isArray(sortSpec) && sortSpec.length > 0;

      // Parse the structured filter spec once. The Zod-validated shape +
      // column-existence check happen inside buildWhere; surface any error
      // as a 400 so the user can fix the bar input.
      let filterSpec = null;
      if (req.query.filter) {
        try {
          filterSpec = JSON.parse(req.query.filter);
        } catch {
          return sendError(res, 400, codes.BAD_REQUEST, 'Invalid filter JSON');
        }
      }
      let whereClause = '', whereParams = [];
      try {
        ({ sql: whereClause, params: whereParams } = buildWhere(filterSpec, columnMetadata));
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }
      const hasFilter = whereClause !== '';

      // Resolve ORDER BY. The helper validates every column, whitelists the
      // direction, quotes identifiers, and appends the PK as final tie-break
      // when the user sort doesn't already include it.
      let orderByClause = '';
      try {
        ({ sql: orderByClause } = buildOrderBy(sortSpec, columnMetadata, primaryKeyColumn));
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }

      // COUNT and the data query are independent — run them concurrently to
      // collapse two latency round-trips into one. The data query is built
      // inline below; count runs alongside it.
      const countPromise = pool.query(
        `SELECT COUNT(*) as total FROM ${qualifiedTable}${whereClause}`,
        whereParams,
      );
      // Build the data query without awaiting, so it runs alongside the count.
      // `emitCursor` marks branches where nextCursor is the last row's PK.
      // Cursor pagination is disabled when a filter is applied OR a user sort
      // is active — the cursor's "next PK > $1" assumption only holds against
      // the default PK-ordered, unfiltered row stream.
      let dataPromise, emitCursor = false;
      const nextParam = (i) => `$${whereParams.length + i}`;

      if (hasUserSort) {
        const offset = (page - 1) * limit;
        dataPromise = pool.query(
          `SELECT * FROM ${qualifiedTable}${whereClause}${orderByClause} LIMIT ${nextParam(1)} OFFSET ${nextParam(2)}`,
          [...whereParams, limit, offset],
        );
      } else if (!hasFilter && primaryKeyColumn && cursor !== undefined) {
        dataPromise = pool.query(
          `SELECT * FROM ${qualifiedTable} WHERE ${quoteIdent(primaryKeyColumn)} > $1${orderByClause} LIMIT $2`,
          [cursor, limit],
        );
        emitCursor = true;
      } else if (!hasFilter && primaryKeyColumn && page === 1) {
        dataPromise = pool.query(
          `SELECT * FROM ${qualifiedTable}${orderByClause} LIMIT $1`,
          [limit],
        );
        emitCursor = true;
      } else {
        const offset = (page - 1) * limit;
        dataPromise = pool.query(
          `SELECT * FROM ${qualifiedTable}${whereClause}${orderByClause} LIMIT ${nextParam(1)} OFFSET ${nextParam(2)}`,
          [...whereParams, limit, offset],
        );
        emitCursor = !hasFilter && !!primaryKeyColumn;
      }

      const [countResult, dataResult] = await Promise.all([countPromise, dataPromise]);
      const totalCount = parseInt(countResult.rows[0].total, 10);
      const nextCursor =
        emitCursor && dataResult.rows.length
          ? dataResult.rows[dataResult.rows.length - 1][primaryKeyColumn]
          : null;

      res.json({
        rows: dataResult.rows,
        totalCount,
        page,
        limit,
        isApproximate: false,
        nextCursor,
        hasPrimaryKey: !!primaryKeyColumn,
        columns: columnMetadata,
      });
    } catch (err) {
      logger.error({ err: err.message, table: req.params.tableName }, 'table read failed');
      return sendError(res, 500, codes.DB_ERROR, err.message);
    }
  });

// ---- Aggregations strip -----------------------------------------------------
//
// GET /api/tables/:tableName/aggregate?filter=<json>&aggs=<json>
//   Per-column aggregations (count/sum/avg/min/max/stddev/count distinct/
//   count true|false) computed against the current filter. `aggs` is a JSON
//   array of { column, fn }; returns { results: [{ column, fn, value }] } in
//   request order. Functions are gated by column type server-side.

const AggregateListQuery = z.object({
  filter: z.string().max(64_000).optional(),
  aggs: z.string().max(64_000).optional(),
});

router.get('/tables/:tableName/aggregate',
  requireConnection,
  validate({
    params: z.object({ tableName: TableNameSchema }),
    query: AggregateListQuery,
  }),
  async (req, res) => {
    const tableName = req.params.tableName;
    const pool = req.pool;
    const schema = req.schema;
    const qualifiedTable = quoteQualifiedIdent(schema, tableName);

    try {
      const { columns: columnMetadata } =
        await getTableMetadata(pool, req.connectionId, schema, tableName);

      let filterSpec = null, aggSpec = null;
      try {
        if (req.query.filter) filterSpec = JSON.parse(req.query.filter);
        if (req.query.aggs) aggSpec = JSON.parse(req.query.aggs);
      } catch {
        return sendError(res, 400, codes.BAD_REQUEST, 'Invalid filter or aggs JSON');
      }

      let whereClause = '', whereParams = [];
      try {
        ({ sql: whereClause, params: whereParams } = buildWhere(filterSpec, columnMetadata));
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }

      let result;
      try {
        result = await computeAggregates(req.connectionId, qualifiedTable, {
          aggs: aggSpec,
          columnMetadata,
          whereSql: whereClause,
          params: whereParams,
        });
      } catch (err) {
        // computeAggregates flags user errors (bad column/fn) with statusCode 400.
        if (err.statusCode === 400) {
          return sendError(res, 400, codes.BAD_REQUEST, err.message);
        }
        throw err;
      }

      res.json(result);
    } catch (err) {
      logger.error({ err: err.message, table: tableName }, 'aggregate failed');
      return sendError(res, 500, codes.DB_ERROR, err.message);
    }
  });

// ---- Per-table data export --------------------------------------------------
//
// GET /api/tables/:tableName/export?format=csv|json|sql&filter=<json>&sort=<json>&columns=<json>
//   Streams the table's rows in the chosen format, respecting the current
//   filter, sort, and (optionally) a visible-column subset. Rows are pulled
//   through a server-side cursor in batches and written straight to the
//   response, so memory stays flat regardless of table size.

const TableExportQuery = z.object({
  format: z.enum(EXPORT_FORMATS).default('csv'),
  filter: z.string().max(64_000).optional(),
  sort: z.string().max(8_000).optional(),
  // JSON array of column names to include (defaults to all, in ordinal order).
  columns: z.string().max(64_000).optional(),
  // Hard cap on rows emitted. Omitted ⇒ every matching row.
  limit: z.coerce.number().int().positive().max(10_000_000).optional(),
});

const EXPORT_BATCH_SIZE = 500;

router.get('/tables/:tableName/export',
  requireConnection,
  validate({
    params: z.object({ tableName: TableNameSchema }),
    query: TableExportQuery,
  }),
  async (req, res) => {
    const tableName = req.params.tableName;
    const pool = req.pool;
    const schema = req.schema;
    const qualifiedTable = quoteQualifiedIdent(schema, tableName);
    const { format, limit } = req.query;

    try {
      const { columns: columnMetadata, primaryKeyColumn } =
        await getTableMetadata(pool, req.connectionId, schema, tableName);

      // Parse the optional JSON params. Bad JSON is a user error → 400.
      let filterSpec = null, sortSpec = null, requestedColumns = null;
      try {
        if (req.query.filter) filterSpec = JSON.parse(req.query.filter);
        if (req.query.sort) sortSpec = JSON.parse(req.query.sort);
        if (req.query.columns) requestedColumns = JSON.parse(req.query.columns);
      } catch {
        return sendError(res, 400, codes.BAD_REQUEST, 'Invalid filter, sort, or columns JSON');
      }

      // Resolve the columns to emit. A requested subset is whitelisted against
      // real columns (preserving request order); unknown names are rejected so
      // a typo can't silently drop data. Default is every column in ordinal
      // order.
      let exportColumns;
      if (Array.isArray(requestedColumns) && requestedColumns.length > 0) {
        const unknown = requestedColumns.filter((c) => !columnMetadata[c]);
        if (unknown.length > 0) {
          return sendError(res, 400, codes.BAD_REQUEST,
            `Unknown export column(s): ${unknown.join(', ')}`);
        }
        exportColumns = requestedColumns;
      } else {
        exportColumns = Object.keys(columnMetadata);
      }

      let whereClause = '', whereParams = [];
      try {
        ({ sql: whereClause, params: whereParams } = buildWhere(filterSpec, columnMetadata));
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }

      let orderByClause = '';
      try {
        ({ sql: orderByClause } = buildOrderBy(sortSpec, columnMetadata, primaryKeyColumn));
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }

      const params = [...whereParams];
      let limitClause = '';
      if (limit) {
        limitClause = ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }
      const colList = exportColumns.map(quoteIdent).join(', ');
      const query =
        `SELECT ${colList} FROM ${qualifiedTable}${whereClause}${orderByClause}${limitClause}`;

      const meta = FORMAT_META[format];
      const safeName = `${tableName}.${meta.extension}`.replace(/[^A-Za-z0-9._-]/g, '_');
      res.setHeader('Content-Type', meta.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

      const serializer = createSerializer(format, { columns: exportColumns, tableName });

      // Backpressure-aware write: pause cursor fetches while the socket drains.
      const write = (chunk) =>
        res.write(chunk) ? Promise.resolve() : new Promise((r) => res.once('drain', r));

      await write(serializer.head());
      await pool.cursor(query, params, EXPORT_BATCH_SIZE, async (rows) => {
        let chunk = '';
        for (const row of rows) chunk += serializer.row(row);
        await write(chunk);
      });
      await write(serializer.foot());
      res.end();
    } catch (err) {
      logger.error({ err: err.message, table: tableName }, 'table export failed');
      // Once streaming has begun the status/headers are already flushed; the
      // best we can do is terminate the (now-truncated) download.
      if (!res.headersSent) {
        return sendError(res, 500, codes.DB_ERROR, err.message);
      }
      res.end();
    }
  });

// ---- Per-table CSV import ---------------------------------------------------
//
// POST /api/tables/:tableName/import
//   Body: {
//     columns: string[],          // target columns, in order
//     rows: unknown[][],          // each row's cells, aligned to `columns`
//     mode: 'insert'|'skip'|'update',
//     conflictColumns?: string[], // required for 'update' (the ON CONFLICT key)
//     emptyAsNull?: boolean,      // blank cell → NULL (default true)
//     dryRun?: boolean,           // count only, then roll back (default false)
//   }
//   Returns: { dryRun, mode, attempted, inserted, updated, conflicts, batches }
//
// The client parses the CSV file, maps headers → columns, and projects each
// row to the chosen target columns; the server validates the columns, builds
// parameterized multi-row INSERTs (batched under Postgres' 65535-param cap),
// and runs every batch inside ONE transaction so the import is all-or-nothing.
// A dry run runs the same statements then rolls back, reporting the counts the
// real run would produce — for plain `insert` mode the dry run probes with
// ON CONFLICT DO NOTHING so it can report conflicts without aborting.

// 65535 params / 1 column ⇒ ~65k rows max per batch; cap total rows per request
// well above any reasonable interactive paste while still bounding the body.
const MAX_IMPORT_ROWS = 500_000;

const ImportBodySchema = z.object({
  columns: z.array(z.string().min(1).max(255)).min(1).max(1600),
  rows: z.array(z.array(z.unknown())).min(1).max(MAX_IMPORT_ROWS),
  mode: z.enum(IMPORT_MODES),
  conflictColumns: z.array(z.string().min(1).max(255)).optional(),
  emptyAsNull: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

// Thrown to unwind porsager's transaction (forcing a ROLLBACK) once a dry run
// has gathered its counts. Carries the tallies back out to the route.
const ROLLBACK = Symbol('pglens-dry-run-rollback');

router.post('/tables/:tableName/import',
  requireConnection,
  validate({
    params: z.object({ tableName: TableNameSchema }),
    body: ImportBodySchema,
  }),
  async (req, res) => {
    const tableName = req.params.tableName;
    const pool = req.pool;
    const schema = req.schema;
    const qualifiedTable = quoteQualifiedIdent(schema, tableName);
    const {
      columns: targetColumns, rows, mode,
      conflictColumns = [], emptyAsNull = true, dryRun = false,
    } = req.body;

    try {
      const { columns: columnMetadata } =
        await getTableMetadata(pool, req.connectionId, schema, tableName);

      // Validate the mapping up front so a bad column 400s before we open a
      // transaction. (buildImportStatement re-checks, but this gives a cleaner
      // single error rather than failing mid-batch.)
      const unknown = targetColumns.filter((c) => !columnMetadata[c]);
      if (unknown.length > 0) {
        return sendError(res, 400, codes.BAD_REQUEST,
          `Unknown column(s): ${unknown.join(', ')}`);
      }
      if (mode === 'update') {
        if (conflictColumns.length === 0) {
          return sendError(res, 400, codes.BAD_REQUEST,
            'Update mode requires conflictColumns', {
              hint: 'Map the table\'s primary-key or a unique column.',
            });
        }
        const badConflict = conflictColumns.filter((c) => !targetColumns.includes(c));
        if (badConflict.length > 0) {
          return sendError(res, 400, codes.BAD_REQUEST,
            `Conflict column(s) not in the mapping: ${badConflict.join(', ')}`);
        }
      }

      // A plain-INSERT dry run can't report conflicts without aborting, so it
      // probes with DO NOTHING. The real run uses the requested mode.
      const planMode = dryRun && mode === 'insert' ? 'skip' : mode;
      const batchSize = batchSizeFor(targetColumns.length);

      const runImport = async (exec) => {
        let attempted = 0, inserted = 0, updated = 0, batches = 0;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const { sql, params } = buildImportStatement({
            qualifiedTable, targetColumns, columnMeta: columnMetadata,
            rows: batch, mode: planMode, conflictColumns, emptyAsNull,
          });
          const result = await exec.query(sql, params);
          attempted += batch.length;
          batches += 1;
          // RETURNING yields a row per affected row, flagged inserted vs
          // updated by (xmax = 0). Rows DO NOTHING skipped are absent.
          for (const r of result.rows) {
            if (r.pglens_inserted) inserted += 1;
            else updated += 1;
          }
        }
        return { attempted, inserted, updated };
      };

      let counts;
      if (dryRun) {
        try {
          await pool.transaction(async (tx) => {
            counts = await runImport(tx);
            throw ROLLBACK; // discard the probe writes
          });
        } catch (err) {
          if (err !== ROLLBACK) throw err;
        }
      } else {
        counts = await pool.transaction(runImport);
      }

      // `attempted - (inserted + updated)` is what ON CONFLICT dropped. For
      // update mode nothing is dropped, so this is 0.
      const conflicts = counts.attempted - counts.inserted - counts.updated;
      res.json({
        dryRun, mode,
        attempted: counts.attempted,
        inserted: counts.inserted,
        updated: counts.updated,
        conflicts,
        batches: dryRun ? undefined : Math.ceil(rows.length / batchSize),
      });
    } catch (err) {
      logger.warn({ err: err.message, table: tableName }, 'import failed');
      return sendError(res, 400, codes.DB_ERROR, err.message, {
        hint: dryRun ? undefined : 'No rows were imported — the transaction rolled back.',
      });
    }
  });

// ---- Inline row edit --------------------------------------------------------
//
// PATCH /api/tables/:tableName/rows
//   Body: { where: { pk_col: value, ... }, set: { col: value, ... } }
//   Returns: { row } — the freshly-updated row, post-trigger.
//
// `where` must list every primary-key column (so the UPDATE can only touch a
// single row). `set` keys must be known columns; jsonb values get `::jsonb`
// cast applied for us. Empty payloads, unknown columns, and missing PK
// columns all 400 with a hint.

const RowUpdateBodySchema = z.object({
  where: z.record(z.string().min(1).max(255), z.unknown()),
  set: z.record(z.string().min(1).max(255), z.unknown()),
});

router.patch('/tables/:tableName/rows',
  requireConnection,
  validate({
    params: z.object({ tableName: TableNameSchema }),
    body: RowUpdateBodySchema,
  }),
  async (req, res) => {
    const tableName = req.params.tableName;
    const pool = req.pool;
    const schema = req.schema;
    const qualifiedTable = quoteQualifiedIdent(schema, tableName);

    try {
      const { columns } = await getTableMetadata(pool, req.connectionId, schema, tableName);

      let built;
      try {
        built = buildUpdateRow(req.body, columns, qualifiedTable);
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }

      const result = await pool.query(built.sql, built.params);
      if (!result.rows.length) {
        // Either the PK changed underneath us or the row was deleted. The
        // client should refetch and replay the edit if still applicable.
        return sendError(res, 404, codes.NOT_FOUND,
          'Row not found — it may have been deleted or its primary key changed', {
            hint: 'Refresh the table and try again.',
          });
      }
      res.json({ row: result.rows[0] });
    } catch (err) {
      logger.warn({ err: err.message, table: tableName }, 'row update failed');
      return sendError(res, 400, codes.DB_ERROR, err.message);
    }
  });

// ---- Row insert -------------------------------------------------------------
//
// POST /api/tables/:tableName/rows
//   Body: { values: { col: value, ... } }
//   Returns: { row } — the freshly-inserted row, post-trigger/default.
//
// Columns omitted from `values` take their DEFAULT (or NULL); an empty object
// inserts an all-defaults row. Unknown columns 400; NOT NULL / CHECK / unique
// violations surface from Postgres through the error envelope.

const RowInsertBodySchema = z.object({
  values: z.record(z.string().min(1).max(255), z.unknown()),
});

router.post('/tables/:tableName/rows',
  requireConnection,
  validate({
    params: z.object({ tableName: TableNameSchema }),
    body: RowInsertBodySchema,
  }),
  async (req, res) => {
    const tableName = req.params.tableName;
    const pool = req.pool;
    const schema = req.schema;
    const qualifiedTable = quoteQualifiedIdent(schema, tableName);

    try {
      const { columns } = await getTableMetadata(pool, req.connectionId, schema, tableName);

      let built;
      try {
        built = buildInsertRow(req.body, columns, qualifiedTable);
      } catch (err) {
        return sendError(res, 400, codes.BAD_REQUEST, err.message);
      }

      const result = await pool.query(built.sql, built.params);
      res.status(201).json({ row: result.rows[0] });
    } catch (err) {
      logger.warn({ err: err.message, table: tableName }, 'row insert failed');
      return sendError(res, 400, codes.DB_ERROR, err.message);
    }
  });

// ---- Schema PATCH + export + import + viz -----------------------------------

router.patch('/connections/:id/schema',
  validate({ params: ConnectionIdParam, body: z.object({ schema: SchemaNameSchema }) }),
  (req, res) => {
    try {
      updateConnectionSchema(req.params.id, req.body.schema);
      res.json({ updated: true });
    } catch (err) {
      return sendError(res, 400, codes.BAD_REQUEST, err.message);
    }
  });

router.get('/export', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const schema = req.schema;

    // Strip anything that could break the header's quoted-string (quotes,
    // control chars, path separators) before interpolating the schema name.
    const safeName = `${schema}_backup.sql`.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

    res.write('-- pglens Database logical dump\n');
    res.write(`-- Schema: ${schema}\n\n`);
    res.write(`SET search_path TO ${quoteIdent(schema)};\n\n`);

    const tablesResult = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    `, [schema]);

    for (const { table_name: tableName } of tablesResult.rows) {
      res.write(`--\n-- Table structure for table ${quoteIdent(tableName)}\n--\n\n`);

      const cols = await pool.query(`
        SELECT column_name, data_type, udt_name, character_maximum_length, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, tableName]);

      let ddl = `DROP TABLE IF EXISTS ${quoteIdent(tableName)} CASCADE;\n`;
      ddl += `CREATE TABLE ${quoteIdent(tableName)} (\n`;
      const defs = cols.rows.map(col => {
        let type = col.data_type;
        if (type === 'USER-DEFINED') type = col.udt_name;
        else if (type === 'ARRAY') {
          type = col.udt_name.startsWith('_') ? col.udt_name.substring(1) + '[]' : col.udt_name + '[]';
        }
        const isSerial = typeof col.column_default === 'string' && col.column_default.startsWith('nextval(');
        if (isSerial) type = type === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
        let def = `  ${quoteIdent(col.column_name)} ${type}`;
        if (!isSerial && col.character_maximum_length &&
          col.data_type !== 'USER-DEFINED' && col.data_type !== 'ARRAY') {
          def += `(${col.character_maximum_length})`;
        }
        if (col.is_nullable === 'NO') def += ' NOT NULL';
        if (!isSerial && col.column_default !== null) def += ` DEFAULT ${col.column_default}`;
        return def;
      });
      ddl += defs.join(',\n') + '\n);\n\n';
      res.write(ddl);

      res.write(`--\n-- Data for table ${quoteIdent(tableName)}\n--\n\n`);
      const rows = await pool.query(`SELECT * FROM ${quoteQualifiedIdent(schema, tableName)}`);
      for (const row of rows.rows) {
        const keys = Object.keys(row).map(k => quoteIdent(k)).join(', ');
        const values = Object.values(row).map(sqlLiteral).join(', ');
        res.write(`INSERT INTO ${quoteIdent(tableName)} (${keys}) VALUES (${values});\n`);
      }
      res.write('\n');
    }
    res.write('-- Dump completed\n');
    res.end();
  } catch (err) {
    logger.error({ err: err.message }, 'export failed');
    if (!res.headersSent) {
      return sendError(res, 500, codes.DB_ERROR, err.message);
    }
    res.end();
  }
});

router.get('/schema', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const schema = req.schema;

    const [tablesResult, columnsResult, constraintsResult, fkResult] = await Promise.all([
      pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      `, [schema]),
      pool.query(`
        SELECT table_name, column_name, data_type, udt_name, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position
      `, [schema]),
      pool.query(`
        SELECT tc.table_name, kcu.column_name, tc.constraint_type
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = $1 AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      `, [schema]),
      pool.query(`
        SELECT kcu.table_name, kcu.column_name,
               ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
      `, [schema]),
    ]);

    const pkCols = {}, uqCols = {};
    for (const row of constraintsResult.rows) {
      const map = row.constraint_type === 'PRIMARY KEY' ? pkCols : uqCols;
      (map[row.table_name] ??= new Set()).add(row.column_name);
    }
    const fkMap = {};
    for (const row of fkResult.rows) {
      (fkMap[row.table_name] ??= {})[row.column_name] = {
        table: row.foreign_table_name, column: row.foreign_column_name,
      };
    }
    const colsByTable = {};
    for (const row of columnsResult.rows) {
      (colsByTable[row.table_name] ??= []).push(row);
    }

    const schemaMap = {};
    for (const { table_name: tableName } of tablesResult.rows) {
      const pkSet = pkCols[tableName] ?? new Set();
      const uqSet = uqCols[tableName] ?? new Set();
      const fkTable = fkMap[tableName] ?? {};
      const columns = (colsByTable[tableName] ?? []).map(col => {
        let type = col.data_type;
        if (type === 'USER-DEFINED') type = col.udt_name;
        else if (type === 'ARRAY') {
          type = col.udt_name.startsWith('_') ? col.udt_name.substring(1) + '[]' : col.udt_name + '[]';
        }
        return {
          name: col.column_name, type,
          maxLength: col.character_maximum_length,
          isNullable: col.is_nullable === 'YES',
          isPrimaryKey: pkSet.has(col.column_name),
          isUnique: uqSet.has(col.column_name),
          isForeignKey: !!fkTable[col.column_name],
          foreignKeyRef: fkTable[col.column_name] || null,
        };
      });
      schemaMap[tableName] = { name: tableName, columns };
    }
    res.json({ schema: schemaMap });
  } catch (err) {
    logger.error({ err: err.message }, 'schema read failed');
    return sendError(res, 500, codes.DB_ERROR, err.message);
  }
});

// ---- Saved views ------------------------------------------------------------
//
// Views persist `(filter + sort + visible columns + column widths + timezone)`
// per (connectionId, tableName). They live in `~/.pglens/views.json` — see
// `src/db/views.js`. Listing is open (no `requireConnection`) so the sidebar
// can show views even when the database isn't reachable.

const ViewListQuery = z.object({
  connectionId: z.string().min(1).max(255).optional(),
  tableName: z.string().min(1).max(255).optional(),
});

const ViewIdParam = z.object({ id: z.string().uuid() });

router.get('/views', validate({ query: ViewListQuery }), (req, res) => {
  res.json({ views: views.listViews(req.query) });
});

router.post('/views', validate({ body: views.ViewBodySchema }), (req, res) => {
  try {
    res.status(201).json({ view: views.createView(req.body) });
  } catch (err) {
    return sendError(res, 400, codes.BAD_REQUEST, err.message);
  }
});

router.put('/views/:id',
  validate({ params: ViewIdParam, body: views.ViewPatchSchema }),
  (req, res) => {
    try {
      const updated = views.updateView(req.params.id, req.body);
      if (!updated) {
        return sendError(res, 404, codes.NOT_FOUND, 'View not found');
      }
      res.json({ view: updated });
    } catch (err) {
      return sendError(res, 400, codes.BAD_REQUEST, err.message);
    }
  });

router.delete('/views/:id', validate({ params: ViewIdParam }), (req, res) => {
  const ok = views.deleteView(req.params.id);
  if (!ok) return sendError(res, 404, codes.NOT_FOUND, 'View not found');
  res.json({ deleted: true });
});

// ---- Raw-SQL escape hatch ---------------------------------------------------

router.post('/query',
  requireConnection,
  validate({ body: QueryBodySchema }),
  async (req, res) => {
    const { sql, params } = req.body;
    const pool = req.pool;
    const schema = req.schema;
    const started = Date.now();
    try {
      // search_path + the user's SQL must run on one reserved connection,
      // otherwise the SET can land on a different pooled backend.
      const result = await pool.queryWithSchema(schema, sql, params);
      // Raw SQL may include DDL — drop cached metadata for this connection.
      invalidateMetadata(req.connectionId);
      const fields = (result.fields || []).map(f => ({ name: f.name, dataTypeID: f.dataTypeID }));
      res.json({
        rows: result.rows,
        fields,
        rowCount: result.rowCount ?? result.rows?.length ?? 0,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'query failed');
      return sendError(res, 400, codes.DB_ERROR, err.message, { hint: `${Date.now() - started}ms` });
    }
  });

// ---- Transaction mode (roadmap §5.3) ---------------------------------------
//
// An Advanced tab in Transaction mode holds one dedicated backend for the life
// of the transaction. BEGIN runs implicitly on the first `/tx/query`; COMMIT /
// ROLLBACK run on the same backend and release it. Sessions are keyed by tab id
// (the auth token scopes the whole map to this install) and a session is bound
// to the connection it opened against.

const TabIdSchema = z.string().min(1).max(255).refine((s) => !s.includes('\0'), 'null byte');

const TxQueryBodySchema = z.object({
  tabId: TabIdSchema,
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

const TxControlBodySchema = z.object({ tabId: TabIdSchema });

// Map a tx-manager error to the right envelope: 409 for state conflicts
// (wrong connection / concurrent query), 503 when the connection is gone,
// otherwise a Postgres error surfaced from the statement.
function txErrorResponse(res, err) {
  const status = err.statusCode || 400;
  const code =
    err.code === 'CONFLICT' ? codes.CONFLICT
      : err.code === 'NO_CONNECTION' ? codes.NO_CONNECTION
        : codes.DB_ERROR;
  return sendError(res, status, code, err.message);
}

router.post('/tx/query',
  requireConnection,
  validate({ body: TxQueryBodySchema }),
  async (req, res) => {
    const { tabId, sql, params } = req.body;
    const started = Date.now();
    try {
      const result = await txManager.runQuery({
        connectionId: req.connectionId,
        tabId,
        schema: req.schema,
        sql,
        params,
      });
      const fields = (result.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
      res.json({
        rows: result.rows,
        fields,
        rowCount: result.rowCount ?? result.rows?.length ?? 0,
        durationMs: Date.now() - started,
        // BEGIN has run by the time the user's statement executes, so the tab
        // holds a transaction even when that statement errored (handled below).
        txOpen: txManager.status(tabId).open,
      });
    } catch (err) {
      logger.warn({ err: err.message, tabId }, 'tx query failed');
      return txErrorResponse(res, err);
    }
  });

router.post('/tx/commit',
  requireConnection,
  validate({ body: TxControlBodySchema }),
  async (req, res) => {
    try {
      const { hadTransaction } = await txManager.commit(req.connectionId, req.body.tabId);
      // Committed DDL may now be visible to pooled reads — drop cached metadata.
      if (hadTransaction) invalidateMetadata(req.connectionId);
      res.json({ committed: true, hadTransaction });
    } catch (err) {
      logger.warn({ err: err.message, tabId: req.body.tabId }, 'tx commit failed');
      return txErrorResponse(res, err);
    }
  });

router.post('/tx/rollback',
  requireConnection,
  validate({ body: TxControlBodySchema }),
  async (req, res) => {
    try {
      const { hadTransaction } = await txManager.rollback(req.connectionId, req.body.tabId);
      res.json({ rolledBack: true, hadTransaction });
    } catch (err) {
      logger.warn({ err: err.message, tabId: req.body.tabId }, 'tx rollback failed');
      return txErrorResponse(res, err);
    }
  });

router.get('/tx/status',
  requireConnection,
  validate({ query: z.object({ tabId: TabIdSchema }) }),
  (req, res) => {
    res.json(txManager.status(req.query.tabId));
  });

// Pretty-print SQL for the Advanced-mode editor (roadmap §5.2 "format on save").
// Pure text transform — no DB connection needed, so this route is open. We run
// the JS `sql-formatter` (postgresql dialect) rather than the Perl pg-formatter
// so a single `npm install` stays sufficient (CLAUDE.md principle #5).
router.post('/format', validate({ body: FormatBodySchema }), (req, res) => {
  try {
    const sql = formatPgSql(req.body.sql, {
      language: 'postgresql',
      keywordCase: 'upper',
      dataTypeCase: 'upper',
      tabWidth: 2,
    });
    res.json({ sql });
  } catch (err) {
    // sql-formatter throws on unparseable input; surface it without the stack.
    return sendError(res, 400, codes.BAD_REQUEST, `Could not format SQL: ${err.message}`);
  }
});

module.exports = router;
