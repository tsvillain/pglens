/**
 * Structured logger.
 *
 * Writes JSON lines to ~/.pglens/logs/pglens.log with daily rotation,
 * and (in dev / when PGLENS_LOG_STDERR is set) mirrors to stderr.
 */

const pino = require('pino');
const { LOG_FILE, ensureLayout } = require('./config/paths');

ensureLayout();

const fileTransport = pino.transport({
  target: 'pino-roll',
  options: {
    file: LOG_FILE,
    frequency: 'daily',
    size: '20m',
    mkdir: true,
  },
});

const logger = pino(
  {
    level: process.env.PGLENS_LOG_LEVEL || 'info',
    base: { app: 'pglens' },
  },
  fileTransport,
);

if (process.env.PGLENS_LOG_STDERR === '1') {
  logger.info({ logFile: LOG_FILE }, 'stderr logging requested but transport-only mode in use; tail the log file instead');
}

module.exports = logger;
