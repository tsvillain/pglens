/**
 * Database Connection Pool Manager
 * 
 * Manages PostgreSQL connection pool using postgres library.
 * Provides connection pooling for efficient database access.
 */

const postgres = require('postgres');

let sql = null;

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
 * Create a new connection pool.
 * Closes existing pool if one exists.
 * @param {string} connectionString - PostgreSQL connection string
 * @param {string} sslMode - SSL mode: disable, require, prefer, verify-ca, verify-full
 * @returns {Promise} The created connection wrapper
 */
function createPool(connectionString, sslMode = 'prefer') {
  if (sql) {
    sql.end();
  }

  const sslConfig = getSslConfig(sslMode);
  const poolConfig = {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  };

  if (sslConfig !== null) {
    poolConfig.ssl = sslConfig;
  }

  sql = postgres(connectionString, poolConfig);

  // Test the connection
  return sql`SELECT NOW()`
    .then(() => {
      console.log('✓ Connected to PostgreSQL database');
      return createPoolWrapper(sql);
    })
    .catch((err) => {
      console.error('✗ Failed to connect to PostgreSQL database:', err.message);
      const recommendation = getSslModeRecommendation(err, sslMode);
      if (recommendation) {
        console.error(`\n💡 SSL Mode Recommendation: Try using --sslmode ${recommendation}`);
        console.error(`   Current SSL mode: ${sslMode}`);
        console.error(`   Suggested command: Add --sslmode ${recommendation} to your command\n`);
      }
      throw err;
    });
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
 * Get the current connection pool.
 * @returns {object} The connection pool wrapper
 * @throws {Error} If pool is not initialized
 */
function getPool() {
  if (!sql) {
    throw new Error('Database pool not initialized. Call createPool first.');
  }
  return createPoolWrapper(sql);
}

/**
 * Close the connection pool gracefully.
 * @returns {Promise} Promise that resolves when pool is closed
 */
function closePool() {
  if (sql) {
    return sql.end();
  }
  return Promise.resolve();
}

module.exports = {
  createPool,
  getPool,
  closePool,
};

