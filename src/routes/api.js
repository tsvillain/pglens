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
const { sendError, codes } = require('../http/errors');
const { validate } = require('../http/validate');
const logger = require('../log');

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
    SELECT column_name, data_type
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
    out[row.column_name] = {
      dataType: row.data_type,
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
        const values = Object.values(row).map(val => {
          if (val === null) return 'NULL';
          if (typeof val === 'number' || typeof val === 'boolean') return val;
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (Array.isArray(val)) {
            const arr = val.map(v => v === null ? 'NULL'
              : typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : v).join(',');
            return `'{${arr}}'`;
          }
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          return `'${String(val).replace(/'/g, "''")}'`;
        }).join(', ');
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

module.exports = router;
