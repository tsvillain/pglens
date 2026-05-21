/**
 * pglens Server
 *
 * Express server with token-gated localhost-only access. The React + TS
 * app under `client-next/dist` is now the only frontend, served at `/`.
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
  // CORS off — same-origin localhost-only.
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: '10mb' }));

  // DNS-rebinding defense: only serve requests whose Host header is a known
  // loopback name. A rebound attacker domain (resolving to 127.0.0.1) would
  // arrive with its own Host header and be rejected here.
  const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', BIND_HOST]);
  app.use((req, res, next) => {
    const raw = req.headers.host || '';
    // Strip the port. Bracketed IPv6 (`[::1]:54321`) keeps the address inside
    // the brackets; otherwise split on the last colon.
    const host = raw.startsWith('[')
      ? raw.slice(1, raw.indexOf(']'))
      : raw.split(':')[0];
    if (!ALLOWED_HOSTS.has(host)) {
      return sendError(res, 403, codes.BAD_REQUEST, 'Invalid Host header');
    }
    next();
  });

  // Health probe — no auth, used by the landing page + Playwright.
  app.get('/api/v3/health', (_req, res) => {
    res.json({ ok: true, version: pkg.version });
  });

  // All other routes require the per-install token.
  app.use(tokenMiddleware);

  app.use('/api', apiRoutes);

  // Legacy redirect: prior versions printed URLs under /v3. Keep the prefix
  // working by 301-redirecting to root so old bookmarks don't 404.
  app.get(/^\/v3(\/.*)?$/, (req, res) => {
    let tail = req.params[0] || '/';
    // Force a single-slash, same-origin path. `/v3//evil.com` would otherwise
    // yield a protocol-relative `//evil.com` redirect (open redirect).
    tail = '/' + tail.replace(/^\/+/, '');
    res.redirect(301, tail);
  });

  const clientPath = path.join(__dirname, '../client-next/dist');
  if (!fs.existsSync(path.join(clientPath, 'index.html'))) {
    logger.error({ clientPath }, 'client-next/dist not built — run `cd client-next && npm run build`');
  }
  app.use(express.static(clientPath));
  app.get('*', (_req, res) => res.sendFile(path.join(clientPath, 'index.html')));

  app.use((err, _req, res, _next) => {
    // Log the full error server-side, but never leak internals to the client.
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    if (res.headersSent) return;
    sendError(res, 500, codes.INTERNAL, 'Internal error');
  });

  return new Promise((resolve) => {
    const server = app.listen(port, BIND_HOST, () => {
      const actualPort = server.address().port;
      const url = `http://${BIND_HOST}:${actualPort}/?token=${token}`;
      logger.info({ port: actualPort, host: BIND_HOST }, 'server listening');
      if (standalone) {
        console.log(`✓ Server running on http://${BIND_HOST}:${actualPort}`);
        console.log(`  Open: ${url}`);
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
