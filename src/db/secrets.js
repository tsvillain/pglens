/**
 * Secret storage for connection passwords.
 *
 * Service:   "pglens"
 * Account:   "<connection-id>"
 * Secret:    raw password string
 *
 * Default backend is the OS keychain via `keytar` (macOS Keychain, Windows
 * Credential Vault, libsecret on Linux) — the Phase 0 hardening.
 *
 * Set `PGLENS_SECRET_STORE=file` to store secrets in `~/.pglens/secrets.json`
 * (mode 0600) instead. Use this for tests, headless/CI runs, and machines
 * whose keychain is unavailable or broken (e.g. macOS "A keychain cannot be
 * found to store …"). If `keytar` can't even be loaded, we degrade to the
 * file store with a warning rather than failing every /connect.
 */

const fs = require('fs');
const logger = require('../log');
const { SECRETS_FILE, ensureLayout } = require('../config/paths');

const SERVICE = 'pglens';

function createKeychainBackend() {
  const keytar = require('keytar'); // native module — throws here if unloadable
  return {
    name: 'keychain',
    set: (account, password) => keytar.setPassword(SERVICE, account, password),
    get: (account) => keytar.getPassword(SERVICE, account),
    del: (account) => keytar.deletePassword(SERVICE, account),
  };
}

function createFileBackend() {
  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeAll = (map) => {
    ensureLayout();
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(map), { mode: 0o600 });
  };
  return {
    name: 'file',
    set: async (account, password) => {
      const map = readAll();
      map[account] = password;
      writeAll(map);
    },
    get: async (account) => {
      const map = readAll();
      return Object.prototype.hasOwnProperty.call(map, account) ? map[account] : null;
    },
    del: async (account) => {
      const map = readAll();
      if (Object.prototype.hasOwnProperty.call(map, account)) {
        delete map[account];
        writeAll(map);
      }
    },
  };
}

let _backend;
function backend() {
  if (_backend) return _backend;
  const choice = (process.env.PGLENS_SECRET_STORE || 'keychain').toLowerCase();
  if (choice === 'file') {
    _backend = createFileBackend();
  } else {
    try {
      _backend = createKeychainBackend();
    } catch (err) {
      logger.warn(
        { err: err.message },
        'keytar unavailable; using file-based secret store (set PGLENS_SECRET_STORE=file to silence)'
      );
      _backend = createFileBackend();
    }
  }
  return _backend;
}

async function setPassword(connectionId, password) {
  if (password == null || password === '') return;
  await backend().set(connectionId, password);
}

async function getPassword(connectionId) {
  try {
    return await backend().get(connectionId);
  } catch (err) {
    logger.warn({ err: err.message, connectionId }, 'secret read failed');
    return null;
  }
}

async function deletePassword(connectionId) {
  try {
    await backend().del(connectionId);
  } catch (err) {
    logger.warn({ err: err.message, connectionId }, 'secret delete failed');
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
