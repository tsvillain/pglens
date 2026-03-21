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
const { getPool, createPool, closePool, checkConnection, getConnections, getConnectionSchema, updateConnection } = require('../db/connection');

const router = express.Router();

/**
 * Middleware to check if connected to database
 */
const requireConnection = async (req, res, next) => {
  const connectionId = req.headers['x-connection-id'];
  if (!connectionId) {
    return res.status(400).json({ error: 'Connection ID header required' });
  }

  const pool = getPool(connectionId);
  if (!pool) {
    return res.status(503).json({ error: 'Not connected to database or invalid connection ID' });
  }

  req.pool = pool;
  req.schema = getConnectionSchema(connectionId);
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
    const { id, name: connectionName } = await createPool(url, sslMode || 'prefer', name, schema || 'public');
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
    const { name: connectionName } = await updateConnection(id, url, sslMode || 'prefer', name, schema || 'public');
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

module.exports = router;
