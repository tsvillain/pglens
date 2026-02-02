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

const PORT_FILE = path.join(os.homedir(), '.pglens.port');

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
  app.use('/api', apiRoutes);

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
