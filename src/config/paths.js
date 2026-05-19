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
  PID_FILE,
  PORT_FILE,
  ensureDir,
  ensureLayout,
};
