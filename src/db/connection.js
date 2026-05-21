/**
 * Database Connection Pool Manager
 *
 * Manages PostgreSQL connection pools using the `postgres` library and the
 * OS keychain for secrets. Each connection is stored as a metadata-only
 * record in `~/.pglens/connections.json`; the password lives in the
 * keychain keyed by connection id.
 */

const fs = require('fs');
const crypto = require('crypto');
const postgres = require('postgres');

const logger = require('../log');
const { quoteIdent } = require('./identifier');
const { CONNECTIONS_FILE, ensureLayout } = require('../config/paths');
const {
  parseConnectionUrl,
  buildConnectionUrl,
  maskedConnectionUrl,
  setPassword,
  getPassword,
  deletePassword,
} = require('./secrets');

// In-memory: id -> { pool, name, meta, sslMode, schema }
//   meta = { protocol, username, host, port, database, params, password? (in mem only) }
const connections = new Map();

function createPoolWrapper(sqlClient) {
  return {
    query: async (queryText, params) => {
      const result = await sqlClient.unsafe(queryText, params || []);
      return { rows: result, fields: result.columns || [], rowCount: result.count };
    },
    /**
     * Run `queryText` with `search_path` pinned to `schema` on a single
     * reserved connection. `SET search_path` and the query must share one
     * backend connection — issuing them as separate pool queries can land on
     * different pooled connections, so the search_path would not apply.
     */
    queryWithSchema: async (schema, queryText, params) => {
      const reserved = await sqlClient.reserve();
      try {
        await reserved.unsafe(`SET search_path TO ${quoteIdent(schema)}`);
        const result = await reserved.unsafe(queryText, params || []);
        return { rows: result, fields: result.columns || [], rowCount: result.count };
      } finally {
        reserved.release();
      }
    },
    end: () => sqlClient.end(),
  };
}

function getSslConfig(sslMode) {
  switch (sslMode?.toLowerCase()) {
    case 'disable':
      return null;
    // `require` is treated as "must be encrypted AND the certificate must
    // verify". This is stricter than libpq (where `require` skips cert
    // checks) but matches user expectations: choosing `require` should not
    // silently accept a MITM cert. Self-signed/dev setups should use
    // `prefer` (best-effort, unverified) or `disable`.
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true };
    // `prefer` (and the default) opportunistically encrypt without verifying
    // the certificate — keeps self-signed and dev databases working.
    case 'prefer':
    default:
      return { rejectUnauthorized: false };
  }
}

function poolConfig(sslMode) {
  const cfg = { max: 10, idle_timeout: 30, connect_timeout: 10, timeout: 30 };
  const ssl = getSslConfig(sslMode);
  if (ssl !== null) cfg.ssl = ssl;
  return cfg;
}

function getSslModeRecommendation(error, currentSslMode) {
  const msg = (error.message || '').toLowerCase();
  const code = error.code;
  if (msg.includes('certificate') || msg.includes('self signed') || msg.includes('unable to verify') ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    if (currentSslMode === 'verify-full' || currentSslMode === 'verify-ca' || currentSslMode === 'prefer') {
      return 'require';
    }
  }
  if (msg.includes('hostname') || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return currentSslMode === 'verify-full' ? 'verify-ca' : 'require';
  }
  if (code === 'ECONNREFUSED' && currentSslMode === 'disable') return 'prefer';
  return null;
}

/**
 * Test + open a postgres pool against the given metadata.
 */
async function openPool(meta, password, sslMode) {
  const url = buildConnectionUrl(meta, password);
  const sql = postgres(url, poolConfig(sslMode));
  await sql`SELECT NOW()`;
  return sql;
}

async function createPool(connectionString, sslMode = 'prefer', customName = null, schema = 'public') {
  const meta = parseConnectionUrl(connectionString);
  if (!meta) {
    throw new Error('Could not parse connection string');
  }
  const password = meta.password;
  delete meta.password;

  try {
    const sql = await openPool(meta, password, sslMode);
    logger.info({ host: meta.host, database: meta.database }, 'connected');

    // Deduplicate against existing connections by (host, port, database, username).
    for (const [existingId, existingConn] of connections.entries()) {
      const m = existingConn.meta;
      if (m.host === meta.host && m.port === meta.port &&
          m.database === meta.database && m.username === meta.username) {
        if (customName && customName !== existingConn.name) existingConn.name = customName;
        sql.end();
        return { id: existingId, name: existingConn.name, reused: true };
      }
    }

    const id = crypto.randomUUID();
    const name = customName || meta.database || 'postgres';
    connections.set(id, { pool: sql, name, meta, sslMode, schema: schema || 'public' });

    await setPassword(id, password);
    saveConnectionsToFile();
    return { id, name };
  } catch (err) {
    logger.error({ err: err.message }, 'connect failed');
    const rec = getSslModeRecommendation(err, sslMode);
    if (rec) err.sslHint = `Try sslmode '${rec}'`;
    throw err;
  }
}

async function updateConnection(id, connectionString, sslMode, name, schema = 'public') {
  const existing = connections.get(id);
  if (!existing) throw new Error('Connection not found');

  const meta = parseConnectionUrl(connectionString);
  if (!meta) throw new Error('Could not parse connection string');
  let password = meta.password;
  delete meta.password;

  // "***" is the masked-password sentinel surfaced by maskedConnectionUrl().
  // When the client submits an unmodified URL/Params edit, swap it for the
  // real keychain entry so the connection re-opens successfully.
  if (password === '***') {
    password = await getPassword(id);
  }

  const sql = await openPool(meta, password, sslMode);
  await existing.pool.end();

  const finalName = name || meta.database || existing.name;
  connections.set(id, { pool: sql, name: finalName, meta, sslMode, schema: schema || 'public' });
  await setPassword(id, password);
  saveConnectionsToFile();
  logger.info({ id, host: meta.host, database: meta.database }, 'connection updated');
  return { id, name: finalName };
}

function checkConnection(connectionId) {
  const conn = connections.get(connectionId);
  if (!conn) return Promise.resolve(false);
  return conn.pool`SELECT 1`.then(() => true).catch(() => false);
}

function getPool(connectionId) {
  const conn = connections.get(connectionId);
  return conn ? createPoolWrapper(conn.pool) : null;
}

function getConnections() {
  const result = [];
  for (const [id, conn] of connections.entries()) {
    result.push({
      id,
      name: conn.name,
      host: conn.meta.host,
      port: conn.meta.port,
      database: conn.meta.database,
      username: conn.meta.username,
      // Masked URL — never expose the raw password.
      connectionString: maskedConnectionUrl({ ...conn.meta, password: true }),
      sslMode: conn.sslMode,
      schema: conn.schema || 'public',
    });
  }
  return result;
}

async function closePool(connectionId) {
  if (connectionId) {
    const conn = connections.get(connectionId);
    if (conn) {
      await conn.pool.end();
      connections.delete(connectionId);
      await deletePassword(connectionId);
      saveConnectionsToFile();
    }
  } else {
    await Promise.all([...connections.values()].map(c => c.pool.end()));
    connections.clear();
  }
}

function saveConnectionsToFile() {
  try {
    ensureLayout();
    const data = [];
    for (const [id, conn] of connections.entries()) {
      data.push({
        id,
        name: conn.name,
        meta: conn.meta,
        sslMode: conn.sslMode,
        schema: conn.schema || 'public',
      });
    }
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to save connections file');
  }
}

function loadConnectionsFromFile() {
  try {
    if (!fs.existsSync(CONNECTIONS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error({ err: err.message }, 'failed to load connections file');
    return [];
  }
}

/**
 * Migrate legacy records that stored `connectionString` (with the password
 * embedded) into the keychain-backed shape. Idempotent: only writes to the
 * keychain when password material is found.
 */
async function migrateLegacyRecord(rec) {
  if (rec.meta) return rec;
  if (typeof rec.connectionString !== 'string') return null;
  const meta = parseConnectionUrl(rec.connectionString);
  if (!meta) return null;
  const password = meta.password;
  delete meta.password;
  if (password) {
    try {
      await setPassword(rec.id, password);
      logger.info({ id: rec.id }, 'migrated password to keychain');
    } catch (err) {
      logger.warn({ id: rec.id, err: err.message }, 'keychain write failed during migration');
    }
  }
  return { id: rec.id, name: rec.name, meta, sslMode: rec.sslMode, schema: rec.schema || 'public' };
}

async function restoreConnections() {
  const saved = loadConnectionsFromFile();
  if (saved.length === 0) return;

  logger.info({ count: saved.length }, 'restoring connections');
  const migrated = [];
  let needsResave = false;

  for (const rec of saved) {
    if (!rec.meta && rec.connectionString) {
      needsResave = true;
      const m = await migrateLegacyRecord(rec);
      if (m) migrated.push(m);
    } else if (rec.meta) {
      migrated.push(rec);
    }
  }

  for (const rec of migrated) {
    try {
      const password = await getPassword(rec.id);
      const sql = await openPool(rec.meta, password, rec.sslMode);
      connections.set(rec.id, {
        pool: sql,
        name: rec.name,
        meta: rec.meta,
        sslMode: rec.sslMode,
        schema: rec.schema || 'public',
      });
      logger.info({ id: rec.id, name: rec.name }, 'restored connection');
    } catch (err) {
      logger.error({ id: rec.id, name: rec.name, err: err.message }, 'restore failed');
    }
  }

  if (needsResave) saveConnectionsToFile();
}

function updateConnectionSchema(connectionId, schema) {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error('Connection not found');
  conn.schema = schema;
  saveConnectionsToFile();
}

function getConnectionSchema(connectionId) {
  const conn = connections.get(connectionId);
  return conn ? (conn.schema || null) : null;
}

function getConnectionString(connectionId) {
  // Returns the *masked* URL. Callers needing the real URL should call the
  // pool directly; passwords no longer leave this module.
  const conn = connections.get(connectionId);
  return conn ? maskedConnectionUrl({ ...conn.meta, password: true }) : null;
}

module.exports = {
  createPool,
  getPool,
  closePool,
  checkConnection,
  getConnections,
  getConnectionSchema,
  updateConnectionSchema,
  updateConnection,
  restoreConnections,
  getConnectionString,
};
