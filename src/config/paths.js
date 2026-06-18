/**
 * Centralized filesystem paths.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PGLENS_DIR = path.join(os.homedir(), '.pglens');
const LOG_DIR = path.join(PGLENS_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'pglens.log');
const TOKEN_FILE = path.join(PGLENS_DIR, 'token');
const CONNECTIONS_FILE = path.join(PGLENS_DIR, 'connections.json');
const VIEWS_FILE = path.join(PGLENS_DIR, 'views.json');
const SAVED_QUERIES_FILE = path.join(PGLENS_DIR, 'saved-queries.json');
const QUERY_HISTORY_FILE = path.join(PGLENS_DIR, 'query-history.json');
// Only used by the file-based secret store (PGLENS_SECRET_STORE=file); the
// keychain backend stores nothing here.
const SECRETS_FILE = path.join(PGLENS_DIR, 'secrets.json');
const PID_FILE = path.join(os.homedir(), '.pglens.pid');
const PORT_FILE = path.join(os.homedir(), '.pglens.port');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function ensureLayout() {
  ensureDir(PGLENS_DIR);
  ensureDir(LOG_DIR);
}

module.exports = {
  PGLENS_DIR,
  LOG_DIR,
  LOG_FILE,
  TOKEN_FILE,
  CONNECTIONS_FILE,
  VIEWS_FILE,
  SAVED_QUERIES_FILE,
  QUERY_HISTORY_FILE,
  SECRETS_FILE,
  PID_FILE,
  PORT_FILE,
  ensureDir,
  ensureLayout,
};
