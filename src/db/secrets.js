/**
 * Keychain-backed secret storage for connection passwords.
 *
 * Service:   "pglens"
 * Account:   "<connection-id>"
 * Secret:    raw password string
 *
 * Uses `keytar` (macOS Keychain, Windows Credential Vault, libsecret on
 * Linux). On Linux without a Secret Service available, keytar throws on
 * setPassword; callers should surface that as a clear error.
 */

const keytar = require('keytar');
const logger = require('../log');

const SERVICE = 'pglens';

async function setPassword(connectionId, password) {
  if (password == null || password === '') return;
  await keytar.setPassword(SERVICE, connectionId, password);
}

async function getPassword(connectionId) {
  try {
    return await keytar.getPassword(SERVICE, connectionId);
  } catch (err) {
    logger.warn({ err: err.message, connectionId }, 'keychain read failed');
    return null;
  }
}

async function deletePassword(connectionId) {
  try {
    await keytar.deletePassword(SERVICE, connectionId);
  } catch (err) {
    logger.warn({ err: err.message, connectionId }, 'keychain delete failed');
  }
}

/**
 * Parse a `postgresql://` URL into structured metadata + the raw password.
 * Returns null for unparseable URLs.
 */
function parseConnectionUrl(connectionString) {
  try {
    const url = new URL(connectionString);
    const protocol = url.protocol.replace(/:$/, '');
    return {
      protocol,
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 5432,
      database: url.pathname.replace(/^\//, '') || 'postgres',
      params: Object.fromEntries(url.searchParams.entries()),
    };
  } catch {
    return null;
  }
}

/**
 * Build a connection URL from structured metadata + the password.
 */
function buildConnectionUrl(meta, password) {
  const proto = meta.protocol || 'postgresql';
  const user = encodeURIComponent(meta.username || '');
  const pw = password != null ? `:${encodeURIComponent(password)}` : '';
  const auth = user || pw ? `${user}${pw}@` : '';
  const port = meta.port ? `:${meta.port}` : '';
  const db = meta.database ? `/${encodeURIComponent(meta.database)}` : '';
  const params = meta.params
    ? Object.entries(meta.params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const query = params ? `?${params}` : '';
  return `${proto}://${auth}${meta.host}${port}${db}${query}`;
}

/**
 * Build a display URL with the password masked. Safe to send to the client.
 */
function maskedConnectionUrl(meta) {
  return buildConnectionUrl(meta, meta.password ? '***' : null);
}

module.exports = {
  setPassword,
  getPassword,
  deletePassword,
  parseConnectionUrl,
  buildConnectionUrl,
  maskedConnectionUrl,
};
