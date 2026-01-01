/**
 * Database Connection Pool Manager
 * 
 * Manages PostgreSQL connection pools using postgres library.
 * Provides connection pooling for efficient database access.
 * Supports multiple simultaneous connections.
 */

const postgres = require('postgres');
const crypto = require('crypto');

// Map to store multiple connections: id -> { pool, name, connectionString }
const connections = new Map();

/**
 * Create a wrapper that provides pg-compatible query interface.
 * The postgres package uses a different API, so we wrap it to maintain compatibility.
 * @param {object} sqlClient - The postgres client instance
 * @returns {object} Wrapped client with .query() method
 */
function createPoolWrapper(sqlClient) {
  return {
    query: async (queryText, params) => {
      const result = await sqlClient.unsafe(queryText, params || []);
      return { rows: result };
    },
    end: () => sqlClient.end(),
  };
}

/**
 * Extract database name from connection string
 * @param {string} connectionString 
 * @returns {string} Database name or 'Unknown'
 */
function getDatabaseName(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.pathname.replace(/^\//, '') || 'postgres';
  } catch (e) {
    return 'postgres';
  }
}

/**
 * Create a new connection pool.
 * @param {string} connectionString - PostgreSQL connection string
 * @param {string} sslMode - SSL mode: disable, require, prefer, verify-ca, verify-full
 * @param {string} [customName] - Optional custom name for the connection
 * @returns {Promise<{id: string, name: string}>} The created connection info
 */
function createPool(connectionString, sslMode = 'prefer', customName = null) {
  const sslConfig = getSslConfig(sslMode);
  const poolConfig = {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    timeout: 30, // Query timeout in seconds
  };

  if (sslConfig !== null) {
    poolConfig.ssl = sslConfig;
  }

  const sql = postgres(connectionString, poolConfig);

  // Test the connection
  return sql`SELECT NOW()`
    .then(() => {
      console.log('✓ Connected to PostgreSQL database');

      // Check if this connection string already exists
      for (const [existingId, existingConn] of connections.entries()) {
        if (existingConn.connectionString === connectionString) {
          // If a custom name is provided and different from existing, update it
          if (customName && customName !== existingConn.name) {
            existingConn.name = customName;
          }
          // Return the existing connection details
          sql.end();
          return { id: existingId, name: existingConn.name, reused: true };
        }
      }

      const id = crypto.randomUUID();
      const name = customName || getDatabaseName(connectionString);

      connections.set(id, {
        pool: sql,
        name,
        connectionString,
        sslMode
      });

      return { id, name };
    })
    .catch((err) => {
      console.error('✗ Failed to connect to PostgreSQL database:', err.message);
      const recommendation = getSslModeRecommendation(err, sslMode);
      if (recommendation) {
        console.error(`\n💡 SSL Mode Recommendation: Try using sslmode '${recommendation}'`);
      }
      throw err;
    });
}

/**
 * Check if a specific connection is active.
 * @param {string} connectionId - Connection ID
 * @returns {Promise<boolean>} True if connected
 */
function checkConnection(connectionId) {
  const conn = connections.get(connectionId);
  if (!conn) {
    return Promise.resolve(false);
  }

  return conn.pool`SELECT 1`
    .then(() => true)
    .catch(() => false);
}

/**
 * Analyze connection error and recommend appropriate SSL mode.
 * @param {Error} error - Connection error object
 * @param {string} currentSslMode - Current SSL mode that failed
 * @returns {string|null} Recommended SSL mode or null if not SSL-related
 */
function getSslModeRecommendation(error, currentSslMode) {
  const errorMessage = error.message?.toLowerCase() || '';
  const errorCode = error.code;
  const errorStack = error.stack?.toLowerCase() || '';

  // Certificate verification errors
  if (
    errorMessage.includes('certificate') ||
    errorMessage.includes('self signed') ||
    errorMessage.includes('unable to verify') ||
    errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    errorCode === 'SELF_SIGNED_CERT_IN_CHAIN'
  ) {
    if (currentSslMode === 'verify-full' || currentSslMode === 'verify-ca') {
      return 'require';
    }
    if (currentSslMode === 'prefer') {
      return 'require';
    }
  }

  // Hostname mismatch errors
  if (
    errorMessage.includes('hostname') ||
    errorMessage.includes('host name') ||
    errorCode === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    if (currentSslMode === 'verify-full') {
      return 'verify-ca';
    }
    return 'require';
  }

  // SSL/TLS protocol errors (but not connection refused, which is handled separately)
  if (
    (errorMessage.includes('ssl') ||
      errorMessage.includes('tls') ||
      errorMessage.includes('protocol') ||
      errorStack.includes('ssl')) &&
    errorCode !== 'ECONNREFUSED'
  ) {
    // If SSL is enabled and failing, try disabling
    if (currentSslMode !== 'disable' && currentSslMode !== 'prefer') {
      // First try prefer (allows fallback to non-SSL)
      if (currentSslMode === 'require' || currentSslMode === 'verify-ca' || currentSslMode === 'verify-full') {
        return 'prefer';
      }
    }
    // If prefer failed, try disable
    if (currentSslMode === 'prefer') {
      return 'disable';
    }
  }

  // Connection refused might indicate SSL requirement
  if (errorCode === 'ECONNREFUSED' || errorMessage.includes('connection refused')) {
    // If SSL is disabled, server might require SSL
    if (currentSslMode === 'disable') {
      return 'prefer';
    }
  }

  // Connection timeout with SSL might need different mode
  if (
    (errorCode === 'ETIMEDOUT' || errorMessage.includes('timeout')) &&
    currentSslMode !== 'disable'
  ) {
    return 'prefer';
  }

  return null;
}

/**
 * Get SSL configuration based on SSL mode.
 * @param {string} sslMode - SSL mode string
 * @returns {object|null} SSL configuration object or null to disable SSL
 */
function getSslConfig(sslMode) {
  switch (sslMode?.toLowerCase()) {
    case 'disable':
      return null;
    case 'require':
      return { rejectUnauthorized: false };
    case 'prefer':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true };
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      return { rejectUnauthorized: false };
  }
}

/**
 * Get a connection pool by ID.
 * @param {string} connectionId - The connection ID
 * @returns {object|null} The connection pool wrapper or null if not found
 */
function getPool(connectionId) {
  const conn = connections.get(connectionId);
  if (!conn) {
    return null;
  }
  return createPoolWrapper(conn.pool);
}

/**
 * Get list of all active connections.
 * @returns {Array<{id: string, name: string}>} List of connections
 */
function getConnections() {
  const result = [];
  for (const [id, conn] of connections.entries()) {
    result.push({
      id,
      name: conn.name,
      connectionString: conn.connectionString,
      sslMode: conn.sslMode
    });
  }
  return result;
}

/**
 * Update an existing connection.
 * @param {string} id - Connection ID to update
 * @param {string} connectionString - New connection string
 * @param {string} sslMode - New SSL mode
 * @param {string} name - New name
 * @returns {Promise<{id: string, name: string}>} Updated connection info
 */
async function updateConnection(id, connectionString, sslMode, name) {
  const existingConn = connections.get(id);
  if (!existingConn) {
    throw new Error('Connection not found');
  }

  const sslConfig = getSslConfig(sslMode);
  const poolConfig = {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    timeout: 30, // Query timeout in seconds
  };

  if (sslConfig !== null) {
    poolConfig.ssl = sslConfig;
  }

  const sql = postgres(connectionString, poolConfig);

  // Test the new connection
  return sql`SELECT NOW()`
    .then(async () => {
      console.log('✓ Updated connection to PostgreSQL database');

      // Close old pool
      await existingConn.pool.end();

      // Update map with new pool and details
      connections.set(id, {
        pool: sql,
        name: name || getDatabaseName(connectionString),
        connectionString,
        sslMode
      });

      return { id, name: connections.get(id).name };
    })
    .catch((err) => {
      console.error('✗ Failed to update connection:', err.message);
      throw err;
    });
}

/**
 * Close a specific connection pool.
 * @param {string} connectionId - The connection ID to close
 * @returns {Promise} Promise that resolves when pool is closed
 */
async function closePool(connectionId) {
  if (connectionId) {
    const conn = connections.get(connectionId);
    if (conn) {
      await conn.pool.end();
      connections.delete(connectionId);
    }
  } else {
    // Close all connections (e.g., on server shutdown)
    const promises = [];
    for (const conn of connections.values()) {
      promises.push(conn.pool.end());
    }
    await Promise.all(promises);
    connections.clear();
  }
}

module.exports = {
  createPool,
  getPool,
  closePool,
  checkConnection,
  getConnections,
  updateConnection
};
