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
const { getPool } = require('../db/connection');

const router = express.Router();

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
router.get('/tables', async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    const tables = result.rows.map(row => row.table_name);
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
async function getPrimaryKeyColumn(pool, tableName) {
  try {
    const pkQuery = `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_name = $1
      AND tc.table_schema = 'public'
    LIMIT 1;
    `;
    const result = await pool.query(pkQuery, [tableName]);
    const pkColumn = result.rows.length > 0 ? result.rows[0].column_name : null;
    return pkColumn;
  } catch (error) {
    console.error('Error getting primary key:', error);
    return null;
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
 *   hasPrimaryKey: boolean
 * }
 */
router.get('/tables/:tableName', async (req, res) => {
  try {
    const tableName = sanitizeTableName(req.params.tableName);
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const cursor = req.query.cursor;

    if (page < 1 || limit < 1) {
      return res.status(400).json({ error: 'Page and limit must be positive integers' });
    }

    const pool = getPool();
    const primaryKeyColumn = await getPrimaryKeyColumn(pool, tableName);

    const countQuery = `SELECT COUNT(*) as total FROM "${tableName}"`;
    const countResult = await pool.query(countQuery);
    const totalCount = parseInt(countResult.rows[0].total, 10);
    const isApproximate = false;

    let dataResult;
    let nextCursor = null;

    if (primaryKeyColumn && cursor) {
      // Cursor-based pagination: WHERE id > cursor (most efficient for forward navigation)
      const cursorQuery = `SELECT * FROM "${tableName}" WHERE "${primaryKeyColumn}" > $1 ORDER BY "${primaryKeyColumn}" ASC LIMIT $2`;
      const cursorParams = [cursor, limit];
      dataResult = await pool.query(cursorQuery, cursorParams);

      if (dataResult.rows.length > 0) {
        const lastRow = dataResult.rows[dataResult.rows.length - 1];
        nextCursor = lastRow[primaryKeyColumn];
      }
    } else if (primaryKeyColumn && page === 1) {
      // First page with primary key: start from beginning, return cursor
      const firstPageQuery = `SELECT * FROM "${tableName}" ORDER BY "${primaryKeyColumn}" ASC LIMIT $1`;
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
        query = `SELECT * FROM "${tableName}" ORDER BY "${primaryKeyColumn}" ASC LIMIT $1 OFFSET $2`;
        queryParams.push(limit, offset);
      } else {
        // No primary key: no ordering guarantee
        query = `SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`;
        queryParams.push(limit, offset);
      }
      dataResult = await pool.query(query, queryParams);

      // Calculate cursor for next page if primary key exists
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
    };
    res.json(responseData);
  } catch (error) {
    console.error('Error fetching table data:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

