/**
 * API Routes
 * 
 * RESTful API endpoints for database operations.
 * 
 * Endpoints:
 * - GET /api/tables - List all tables in the database
 * - GET /api/tables/:tableName - Get paginated table data
 * 
 * Features:
 * - SQL injection prevention via table name sanitization
 * - Cursor-based pagination for efficient large table navigation
 * - Automatic primary key detection for optimized pagination
 */

const express = require('express');
const { getPool, createPool, closePool, checkConnection, getConnections, getConnectionSchema, updateConnectionSchema, updateConnection } = require('../db/connection');

const router = express.Router();

/**
 * Middleware to check if connected to database
 */
const requireConnection = async (req, res, next) => {
  const connectionId = req.headers['x-connection-id'] || req.query.connectionId;
  if (!connectionId) {
    return res.status(400).json({ error: 'Connection ID required' });
  }

  const pool = getPool(connectionId);
  if (!pool) {
    return res.status(503).json({ error: 'Not connected to database or invalid connection ID' });
  }

  req.pool = pool;
  try {
    req.schema = sanitizeSchemaName(getConnectionSchema(connectionId));
  } catch {
    return res.status(400).json({ error: 'Connection has an invalid schema name' });
  }
  next();
};

/**
 * POST /api/connect
 * Connect to a PostgreSQL database
 */
router.post('/connect', async (req, res) => {
  const { url, sslMode, name, schema } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Connection string is required' });
  }

  try {
    const { id, name: connectionName } = await createPool(url, sslMode || 'prefer', name, sanitizeSchemaName(schema || 'public'));
    res.json({ connected: true, connectionId: id, name: connectionName });
  } catch (error) {
    res.status(400).json({
      connected: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/connections/:id
 * Update an existing connection
 */
router.put('/connections/:id', async (req, res) => {
  const { id } = req.params;
  const { url, sslMode, name, schema } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Connection string is required' });
  }

  try {
    const { name: connectionName } = await updateConnection(id, url, sslMode || 'prefer', name, sanitizeSchemaName(schema || 'public'));
    res.json({ updated: true, connectionId: id, name: connectionName });
  } catch (error) {
    res.status(400).json({
      updated: false,
      error: error.message
    });
  }
});

/**
 * GET /api/connections
 * List active connections
 */
router.get('/connections', (req, res) => {
  const connections = getConnections();
  res.json({ connections });
});

/**
 * POST /api/disconnect
 * Disconnect from a database
 */
router.post('/disconnect', async (req, res) => {
  const connectionId = req.body.connectionId || req.headers['x-connection-id'];

  if (!connectionId) {
    return res.status(400).json({ error: 'Connection ID required' });
  }

  try {
    await closePool(connectionId);
    res.json({ connected: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/status
 * Check connection status
 */
router.get('/status', async (req, res) => {
  const connectionId = req.headers['x-connection-id'];
  if (!connectionId) {
    return res.json({ connected: false });
  }

  try {
    const connected = await checkConnection(connectionId);
    res.json({ connected });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

/**
 * GET /api/schemas
 * List all schemas in the connected database.
 */
router.get('/schemas', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      ORDER BY schema_name;
    `);
    const schemas = result.rows.map(row => row.schema_name);
    res.json({ schemas });
  } catch (error) {
    console.error('Error fetching schemas:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Sanitize schema name to prevent SQL injection.
 * Only allows alphanumeric characters and underscores (standard PostgreSQL identifiers).
 * Rejects anything that could break out of double-quote identifier quoting.
 * @param {string} schemaName - Schema name to sanitize
 * @returns {string} Sanitized schema name
 * @throws {Error} If schema name contains invalid characters
 */
function sanitizeSchemaName(schemaName) {
  if (!schemaName || !/^[a-zA-Z0-9_]+$/.test(schemaName)) {
    throw new Error('Invalid schema name');
  }
  return schemaName;
}

/**
 * Sanitize table name to prevent SQL injection.
 * Only allows alphanumeric characters, underscores, and dots.
 * @param {string} tableName - Table name to sanitize
 * @returns {string} Sanitized table name
 * @throws {Error} If table name contains invalid characters
 */
function sanitizeTableName(tableName) {
  if (!/^[a-zA-Z0-9_.]+$/.test(tableName)) {
    throw new Error('Invalid table name');
  }
  return tableName;
}

/**
 * GET /api/tables
 * 
 * Returns a list of all tables in the public schema.
 * Only returns BASE TABLE types (excludes views, sequences, etc.).
 * 
 * Response: { tables: string[] }
 */
router.get('/tables', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const schema = req.schema;
    const result = await pool.query(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name;
    `, [schema]);

    const tables = result.rows.map(row => ({
      name: row.table_name,
      type: row.table_type === 'VIEW' ? 'view' : 'table'
    }));
    res.json({ tables });
  } catch (error) {
    console.error('Error fetching tables:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get the primary key column name for a table.
 * Used to enable cursor-based pagination for better performance.
 * @param {Pool} pool - Database connection pool
 * @param {string} tableName - Name of the table
 * @returns {Promise<string|null>} Primary key column name or null if no primary key exists
 */
async function getPrimaryKeyColumn(pool, tableName, schema) {
  try {
    const pkQuery = `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_name = $1
      AND tc.table_schema = $2
    LIMIT 1;
    `;
    const result = await pool.query(pkQuery, [tableName, schema]);
    const pkColumn = result.rows.length > 0 ? result.rows[0].column_name : null;
    return pkColumn;
  } catch (error) {
    console.error('Error getting primary key:', error);
    return null;
  }
}

/**
 * Get foreign key relationships for a table.
 * Queries information_schema to get foreign key constraints and their references.
 * @param {Pool} pool - Database connection pool
 * @param {string} tableName - Name of the table
 * @returns {Promise<Object>} Object mapping column names to their foreign key references { table, column }
 */
async function getForeignKeyRelations(pool, tableName, schema) {
  try {
    const fkQuery = `
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1
        AND tc.table_schema = $2;
    `;
    const result = await pool.query(fkQuery, [tableName, schema]);
    const foreignKeys = {};
    result.rows.forEach(row => {
      foreignKeys[row.column_name] = {
        table: row.foreign_table_name,
        column: row.foreign_column_name
      };
    });
    return foreignKeys;
  } catch (error) {
    console.error('Error getting foreign key relations:', error);
    return {};
  }
}

/**
 * Get all primary key columns for a table.
 * @param {Pool} pool - Database connection pool
 * @param {string} tableName - Name of the table
 * @returns {Promise<Set>} Set of primary key column names
 */
async function getPrimaryKeyColumns(pool, tableName, schema) {
  try {
    const pkQuery = `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_name = $1
        AND tc.table_schema = $2;
    `;
    const result = await pool.query(pkQuery, [tableName, schema]);
    const pkColumns = new Set();
    result.rows.forEach(row => {
      pkColumns.add(row.column_name);
    });
    return pkColumns;
  } catch (error) {
    console.error('Error getting primary key columns:', error);
    return new Set();
  }
}

/**
 * Get all unique constraint columns for a table.
 * @param {Pool} pool - Database connection pool
 * @param {string} tableName - Name of the table
 * @returns {Promise<Set>} Set of unique constraint column names
 */
async function getUniqueColumns(pool, tableName, schema) {
  try {
    const uniqueQuery = `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'UNIQUE'
        AND tc.table_name = $1
        AND tc.table_schema = $2;
    `;
    const result = await pool.query(uniqueQuery, [tableName, schema]);
    const uniqueColumns = new Set();
    result.rows.forEach(row => {
      uniqueColumns.add(row.column_name);
    });
    return uniqueColumns;
  } catch (error) {
    console.error('Error getting unique columns:', error);
    return new Set();
  }
}

/**
 * Get column metadata (datatypes and key relationships) for a table.
 * Queries information_schema.columns to get column names and their data types,
 * and includes key relationship information (primary keys, foreign keys, unique constraints).
 * @param {Pool} pool - Database connection pool
 * @param {string} tableName - Name of the table
 * @returns {Promise<Object>} Object mapping column names to metadata objects with dataType, isPrimaryKey, isForeignKey, foreignKeyRef, isUnique
 */
async function getColumnMetadata(pool, tableName, schema) {
  try {
    const metadataQuery = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $2
      AND table_name = $1
      ORDER BY ordinal_position;
    `;
    const result = await pool.query(metadataQuery, [tableName, schema]);

    const primaryKeyColumns = await getPrimaryKeyColumns(pool, tableName, schema);
    const foreignKeyRelations = await getForeignKeyRelations(pool, tableName, schema);
    const uniqueColumns = await getUniqueColumns(pool, tableName, schema);

    const columns = {};
    result.rows.forEach(row => {
      const columnName = row.column_name;
      columns[columnName] = {
        dataType: row.data_type,
        isPrimaryKey: primaryKeyColumns.has(columnName),
        isForeignKey: !!foreignKeyRelations[columnName],
        foreignKeyRef: foreignKeyRelations[columnName] || null,
        isUnique: uniqueColumns.has(columnName)
      };
    });
    return columns;
  } catch (error) {
    console.error('Error getting column metadata:', error);
    return {};
  }
}

/**
 * GET /api/tables/:tableName
 * 
 * Returns paginated table data with support for cursor-based pagination.
 * 
 * Query parameters:
 * - page: Page number (default: 1)
 * - limit: Rows per page (default: 100)
 * - cursor: Cursor value for cursor-based pagination (optional)
 * 
 * Pagination strategy:
 * - If table has primary key and cursor is provided: Use cursor-based pagination (WHERE id > cursor)
 * - If table has primary key and page=1: Start from beginning, return cursor for next page
 * - Otherwise: Use OFFSET-based pagination (for backward nav, page jumps, or tables without PK)
 * 
 * Response: {
 *   rows: Object[],
 *   totalCount: number,
 *   page: number,
 *   limit: number,
 *   isApproximate: boolean,
 *   nextCursor: string|null,
 *   hasPrimaryKey: boolean,
 *   columns: Object - Map of column names to metadata objects with:
 *     - dataType: string
 *     - isPrimaryKey: boolean
 *     - isForeignKey: boolean
 *     - foreignKeyRef: { table: string, column: string } | null
 *     - isUnique: boolean
 * }
 */
router.get('/tables/:tableName', requireConnection, async (req, res) => {
  try {
    const tableName = sanitizeTableName(req.params.tableName);
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const cursor = req.query.cursor;
    const sortColumn = req.query.sortColumn ? req.query.sortColumn : null;
    const sortDirection = req.query.sortDirection === 'desc' ? 'DESC' : 'ASC';

    if (page < 1 || limit < 1) {
      return res.status(400).json({ error: 'Page and limit must be positive integers' });
    }

    const pool = req.pool;
    const schema = req.schema;
    const qualifiedTable = `"${schema}"."${tableName}"`;
    const primaryKeyColumn = await getPrimaryKeyColumn(pool, tableName, schema);
    const columnMetadata = await getColumnMetadata(pool, tableName, schema);

    // Validate sortColumn if provided
    if (sortColumn && !columnMetadata[sortColumn]) {
      return res.status(400).json({ error: 'Invalid sort column' });
    }

    const countQuery = `SELECT COUNT(*) as total FROM ${qualifiedTable}`;
    const countResult = await pool.query(countQuery);
    const totalCount = parseInt(countResult.rows[0].total, 10);
    const isApproximate = false;

    let dataResult;
    let nextCursor = null;

    if (sortColumn) {
      // Custom Sorting: Use OFFSET-based pagination
      // Always add primary key (if exists) as secondary sort for stability
      const offset = (page - 1) * limit;
      let orderByClause = `ORDER BY "${sortColumn}" ${sortDirection}`;

      if (primaryKeyColumn && sortColumn !== primaryKeyColumn) {
        orderByClause += `, "${primaryKeyColumn}" ASC`;
      }

      const query = `SELECT * FROM ${qualifiedTable} ${orderByClause} LIMIT $1 OFFSET $2`;
      dataResult = await pool.query(query, [limit, offset]);

      // Cursor not valid for custom sorts in this simple implementation
      nextCursor = null;
    } else if (primaryKeyColumn && cursor) {
      // Cursor-based pagination: WHERE id > cursor (most efficient for forward navigation)
      const cursorQuery = `SELECT * FROM ${qualifiedTable} WHERE "${primaryKeyColumn}" > $1 ORDER BY "${primaryKeyColumn}" ASC LIMIT $2`;
      const cursorParams = [cursor, limit];
      dataResult = await pool.query(cursorQuery, cursorParams);

      if (dataResult.rows.length > 0) {
        const lastRow = dataResult.rows[dataResult.rows.length - 1];
        nextCursor = lastRow[primaryKeyColumn];
      }
    } else if (primaryKeyColumn && page === 1) {
      // First page with primary key: start from beginning, return cursor
      const firstPageQuery = `SELECT * FROM ${qualifiedTable} ORDER BY "${primaryKeyColumn}" ASC LIMIT $1`;
      const firstPageParams = [limit];
      dataResult = await pool.query(firstPageQuery, firstPageParams);

      if (dataResult.rows.length > 0) {
        const lastRow = dataResult.rows[dataResult.rows.length - 1];
        nextCursor = lastRow[primaryKeyColumn];
      }
    } else {
      // Fallback to OFFSET-based pagination
      // Used for: backward navigation, page jumps, or tables without primary key
      const offset = (page - 1) * limit;
      let query;
      const queryParams = [];

      if (primaryKeyColumn) {
        // Order by primary key for consistent results
        query = `SELECT * FROM ${qualifiedTable} ORDER BY "${primaryKeyColumn}" ASC LIMIT $1 OFFSET $2`;
        queryParams.push(limit, offset);
      } else {
        // No primary key: no ordering guarantee
        query = `SELECT * FROM ${qualifiedTable} LIMIT $1 OFFSET $2`;
        queryParams.push(limit, offset);
      }
      dataResult = await pool.query(query, queryParams);

      // Calculate cursor for next page if primary key exists (only if default sort)
      if (primaryKeyColumn && dataResult.rows.length > 0) {
        const lastRow = dataResult.rows[dataResult.rows.length - 1];
        nextCursor = lastRow[primaryKeyColumn];
      }
    }

    const responseData = {
      rows: dataResult.rows,
      totalCount,
      page,
      limit,
      isApproximate,
      nextCursor,
      hasPrimaryKey: !!primaryKeyColumn,
      columns: columnMetadata,
    };
    res.json(responseData);
  } catch (error) {
    console.error('Error fetching table data:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/connections/:id/schema
 * Update the active schema for an existing connection without reconnecting
 */
router.patch('/connections/:id/schema', async (req, res) => {
  const { id } = req.params;
  const { schema } = req.body;

  if (!schema) {
    return res.status(400).json({ error: 'schema is required' });
  }

  try {
    updateConnectionSchema(id, sanitizeSchemaName(schema));
    res.json({ updated: true });
  } catch (error) {
    res.status(400).json({ updated: false, error: error.message });
  }
});

/**
 * GET /api/export
 * Exports the database to a downloadable .sql file
 */
router.get('/export', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const schema = req.schema;

    // Set headers for file download
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${schema}_backup.sql"`);

    res.write('-- pglens Database logical dump\n');
    res.write(`-- Schema: ${schema}\n\n`);
    res.write(`SET search_path TO "${schema}";\n\n`);

    // 1. Fetch all tables in the schema
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
    `, [schema]);
    const tables = tablesResult.rows.map(row => row.table_name);

    for (const tableName of tables) {
      res.write(`--\n-- Table structure for table "${tableName}"\n--\n\n`);

      // 2. Fetch columns for the table
      const columnsResult = await pool.query(`
        SELECT column_name, data_type, udt_name, character_maximum_length, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
        AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, tableName]);

      let createTableSql = `DROP TABLE IF EXISTS "${tableName}" CASCADE;\n`;
      createTableSql += `CREATE TABLE "${tableName}" (\n`;
      const columnDefs = columnsResult.rows.map(col => {
        let actualDataType = col.data_type;
        if (col.data_type === 'USER-DEFINED') {
          actualDataType = col.udt_name;
        } else if (col.data_type === 'ARRAY') {
          // udt_name for arrays typically starts with an underscore, e.g., '_text' -> 'text[]'
          actualDataType = col.udt_name.startsWith('_') ? col.udt_name.substring(1) + '[]' : col.udt_name + '[]';
        }

        let isSerial = col.column_default && typeof col.column_default === 'string' && col.column_default.startsWith("nextval(");
        if (isSerial) {
          if (actualDataType === 'bigint') actualDataType = 'BIGSERIAL';
          else actualDataType = 'SERIAL';
        }

        let def = `  "${col.column_name}" ${actualDataType}`;
        if (!isSerial && col.character_maximum_length && col.data_type !== 'USER-DEFINED' && col.data_type !== 'ARRAY') {
          def += `(${col.character_maximum_length})`;
        }
        if (col.is_nullable === 'NO') {
          def += ' NOT NULL';
        }
        if (!isSerial && col.column_default !== null) {
          def += ` DEFAULT ${col.column_default}`;
        }
        return def;
      });
      createTableSql += columnDefs.join(',\n') + '\n);\n\n';
      res.write(createTableSql);

      res.write(`--\n-- Data for table "${tableName}"\n--\n\n`);

      // 3. Fetch rows for the table
      const rowsResult = await pool.query(`SELECT * FROM "${schema}"."${tableName}"`);
      if (rowsResult.rows.length > 0) {
        for (const row of rowsResult.rows) {
          const keys = Object.keys(row).map(k => `"${k}"`).join(', ');
          const values = Object.values(row).map(val => {
            if (val === null) return 'NULL';
            if (typeof val === 'number' || typeof val === 'boolean') return val;
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (Array.isArray(val)) {
              // Format javascript arrays to postgres array literal '{...}'
              const arrayLiteral = val.map(v => {
                if (v === null) return 'NULL';
                if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
                return v;
              }).join(',');
              return `'{${arrayLiteral}}'`;
            }
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            // Escape single quotes for string values
            return `'${String(val).replace(/'/g, "''")}'`;
          }).join(', ');

          res.write(`INSERT INTO "${tableName}" (${keys}) VALUES (${values});\n`);
        }
      }
      res.write('\n');
    }

    res.write('-- Dump completed\n');
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export database', details: error.message });
    } else {
      res.end(); // Close stream on error if headers already sent
    }
  }
});

/**
 * POST /api/import
 * Imports a .sql file into the database
 */
router.post('/import', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const schema = req.schema;

    let sqlString = '';
    req.on('data', chunk => {
      sqlString += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (!sqlString.trim()) {
          return res.status(400).json({ error: 'SQL file is empty.' });
        }

        // Execute raw SQL script with schema search_path
        await pool.query(`SET search_path TO "${schema}";\n${sqlString}`);
        res.json({ success: true, message: 'Database imported successfully.' });
      } catch (err) {
        console.error('Import execution error:', err);
        res.status(500).json({ error: 'Import failed during execution', details: err.message });
      }
    });

    req.on('error', (err) => {
      console.error('Request stream error:', err);
      res.status(500).json({ error: 'Error reading upload stream', details: err.message });
    });

  } catch (error) {
    console.error('Import setup error:', error);
    res.status(500).json({ error: 'Failed to initiate import', details: error.message });
  }
});

/**
 * GET /api/schema
 * 
 * Returns a structured representation of the database schema for visualization.
 * Includes tables, columns, data types, primary keys, unique constraints, and foreign key relationships.
 */
router.get('/schema', requireConnection, async (req, res) => {
  try {
    const pool = req.pool;
    const schema = req.schema;

    // Fire all 4 queries in parallel — one round trip each instead of 3N+1
    const [tablesResult, columnsResult, constraintsResult, fkResult] = await Promise.all([
      pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
      `, [schema]),

      pool.query(`
        SELECT table_name, column_name, data_type, udt_name, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
        ORDER BY table_name, ordinal_position
      `, [schema]),

      // Primary keys and unique constraints in one query
      pool.query(`
        SELECT tc.table_name, kcu.column_name, tc.constraint_type
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = $1
          AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      `, [schema]),

      pool.query(`
        SELECT
          kcu.table_name,
          kcu.column_name,
          ccu.table_name  AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
      `, [schema])
    ]);

    // Index constraint results by table for O(1) lookup
    const pkCols = {};    // { tableName: Set<columnName> }
    const uqCols = {};    // { tableName: Set<columnName> }
    for (const row of constraintsResult.rows) {
      if (row.constraint_type === 'PRIMARY KEY') {
        (pkCols[row.table_name] ??= new Set()).add(row.column_name);
      } else {
        (uqCols[row.table_name] ??= new Set()).add(row.column_name);
      }
    }

    const fkMap = {};    // { tableName: { columnName: { table, column } } }
    for (const row of fkResult.rows) {
      (fkMap[row.table_name] ??= {})[row.column_name] = {
        table: row.foreign_table_name,
        column: row.foreign_column_name
      };
    }

    const colsByTable = {};  // { tableName: row[] }
    for (const row of columnsResult.rows) {
      (colsByTable[row.table_name] ??= []).push(row);
    }

    // Build response
    const schemaMap = {};
    for (const { table_name: tableName } of tablesResult.rows) {
      const pkSet = pkCols[tableName] ?? new Set();
      const uqSet = uqCols[tableName] ?? new Set();
      const fkTable = fkMap[tableName] ?? {};

      const columns = (colsByTable[tableName] ?? []).map(col => {
        let actualDataType = col.data_type;
        if (col.data_type === 'USER-DEFINED') {
          actualDataType = col.udt_name;
        } else if (col.data_type === 'ARRAY') {
          actualDataType = col.udt_name.startsWith('_') ? col.udt_name.substring(1) + '[]' : col.udt_name + '[]';
        }
        return {
          name: col.column_name,
          type: actualDataType,
          maxLength: col.character_maximum_length,
          isNullable: col.is_nullable === 'YES',
          isPrimaryKey: pkSet.has(col.column_name),
          isUnique: uqSet.has(col.column_name),
          isForeignKey: !!fkTable[col.column_name],
          foreignKeyRef: fkTable[col.column_name] || null
        };
      });

      schemaMap[tableName] = { name: tableName, columns };
    }

    res.json({ schema: schemaMap });
  } catch (error) {
    console.error('Error fetching schema:', error);
    res.status(500).json({ error: 'Failed to fetch database schema', details: error.message });
  }
});

module.exports = router;
