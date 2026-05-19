/**
 * pglens Server
 * 
 * Express server that serves the web UI and provides API endpoints
 * for querying PostgreSQL database tables.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { createPool, closePool, restoreConnections } = require('./db/connection');
const apiRoutes = require('./routes/api');
const pkg = require('../package.json');

const PORT_FILE = path.join(os.homedir(), '.pglens.port');

// Phase 0 strangler-fig: serve the new React app at /v3 behind a flag.
// Default ON; set PGLENS_V3=0 to disable.
const V3_ENABLED = process.env.PGLENS_V3 !== '0';

/**
 * Check if a port is in use.
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

async function startServer({ standalone = true } = {}) {
  const app = express();
  let port = 54321;

  await restoreConnections();

  if (await isPortInUse(port)) {
    port = 0;
  }

  app.use(cors());
  app.use(express.json());

  app.get('/api/v3/health', (_req, res) => {
    res.json({ ok: true, version: pkg.version });
  });

  app.use('/api', apiRoutes);

  const v3DistPath = path.join(__dirname, '../client-next/dist');
  const v3Available = V3_ENABLED && fs.existsSync(path.join(v3DistPath, 'index.html'));

  if (v3Available) {
    app.use('/v3', express.static(v3DistPath));
    app.get('/v3/*', (_req, res) => {
      res.sendFile(path.join(v3DistPath, 'index.html'));
    });
  } else if (V3_ENABLED) {
    app.get('/v3*', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('pglens v3 not built. Run: cd client-next && npm run build');
    });
  }

  const clientPath = path.join(__dirname, '../client');
  app.use(express.static(clientPath));

  app.get('*', (_, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      if (standalone) {
        console.log(`✓ Server running on http://localhost:${actualPort}`);
        console.log(`  Open your browser to view your database`);
        if (v3Available) {
          console.log(`  v3 preview: http://localhost:${actualPort}/v3`);
        }
        fs.writeFileSync(PORT_FILE, actualPort.toString());
      }
      resolve(actualPort);
    });

    const shutdown = () => {
      if (standalone) console.log('\nShutting down...');
      if (fs.existsSync(PORT_FILE)) {
        try { fs.unlinkSync(PORT_FILE); } catch (e) { }
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
