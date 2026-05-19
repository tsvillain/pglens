/**
 * pglens Server
 *
 * Express server with token-gated localhost-only access. Mounts the legacy
 * vanilla client at `/`, the v3 React app at `/v3` behind PGLENS_V3, and
 * the API at `/api`. All routes require the per-install token (cookie or
 * x-pglens-token header).
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const net = require('net');

const pkg = require('../package.json');
const logger = require('./log');
const { PORT_FILE } = require('./config/paths');
const { tokenMiddleware, loadOrCreateToken } = require('./auth');
const { sendError, codes } = require('./http/errors');
const { closePool, restoreConnections } = require('./db/connection');
const apiRoutes = require('./routes/api');

const V3_ENABLED = process.env.PGLENS_V3 !== '0';
const DEFAULT_PORT = 54321;
const BIND_HOST = process.env.PGLENS_BIND || '127.0.0.1';

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, BIND_HOST);
  });
}

async function startServer({ standalone = true } = {}) {
  const token = loadOrCreateToken();

  await restoreConnections();

  const app = express();
  let port = DEFAULT_PORT;
  if (await isPortInUse(port)) port = 0;

  app.use(cookieParser());
  // CORS is intentionally not required (same-origin only via localhost bind),
  // but kept for tooling like `curl --json` against the API.
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: '10mb' }));

  // Health probe does not require auth — used by the v3 landing for ready-check.
  app.get('/api/v3/health', (_req, res) => {
    res.json({ ok: true, version: pkg.version });
  });

  // Everything else requires the per-install token.
  app.use(tokenMiddleware);

  app.use('/api', apiRoutes);

  const v3DistPath = path.join(__dirname, '../client-next/dist');
  const v3Available = V3_ENABLED && fs.existsSync(path.join(v3DistPath, 'index.html'));

  if (v3Available) {
    app.use('/v3', express.static(v3DistPath));
    app.get('/v3/*', (_req, res) => res.sendFile(path.join(v3DistPath, 'index.html')));
  } else if (V3_ENABLED) {
    app.get('/v3*', (_req, res) =>
      res.status(503).type('text/plain').send('pglens v3 not built. Run: cd client-next && npm run build'),
    );
  }

  const clientPath = path.join(__dirname, '../client');
  app.use(express.static(clientPath));
  app.get('*', (_req, res) => res.sendFile(path.join(clientPath, 'index.html')));

  // Final error handler — convert any uncaught error into the envelope.
  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    if (res.headersSent) return;
    sendError(res, 500, codes.INTERNAL, err.message || 'Internal error');
  });

  return new Promise((resolve) => {
    const server = app.listen(port, BIND_HOST, () => {
      const actualPort = server.address().port;
      const url = `http://${BIND_HOST}:${actualPort}/?token=${token}`;
      logger.info({ port: actualPort, host: BIND_HOST, v3: v3Available }, 'server listening');
      if (standalone) {
        console.log(`✓ Server running on http://${BIND_HOST}:${actualPort}`);
        console.log(`  Open: ${url}`);
        if (v3Available) {
          console.log(`  v3 preview: http://${BIND_HOST}:${actualPort}/v3/?token=${token}`);
        }
        fs.writeFileSync(PORT_FILE, actualPort.toString(), { mode: 0o600 });
      }
      resolve({ port: actualPort, token, url });
    });

    const shutdown = () => {
      if (standalone) console.log('\nShutting down...');
      logger.info('shutdown requested');
      if (fs.existsSync(PORT_FILE)) {
        try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
      }
      closePool().then(() => {
        if (standalone) process.exit(0);
      });
    };

    if (standalone) {
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }
  });
}

module.exports = { startServer };
