/**
 * pglens Server
 * 
 * Express server that serves the web UI and provides API endpoints
 * for querying PostgreSQL database tables.
 * 
 * Features:
 * - RESTful API for table listing and data retrieval
 * - Static file serving for the client application
 * - CORS enabled for development
 * - Graceful shutdown handling
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createPool, closePool } = require('./db/connection');
const apiRoutes = require('./routes/api');

/**
 * Start the Express server.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');

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

/**
 * Start the Express server.
 */
async function startServer() {
  const app = express();
  let port = 54321;

  // Try to find an available port starting from 54321
  if (await isPortInUse(port)) {
    port = 0; // Let OS choose a random available port
  }

  app.use(cors());
  app.use(express.json());

  app.use('/api', apiRoutes);

  const clientPath = path.join(__dirname, '../client');
  app.use(express.static(clientPath));

  app.get('*', (_, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });

  const server = app.listen(port, () => {
    const actualPort = server.address().port;
    console.log(`✓ Server running on http://localhost:${actualPort}`);
    console.log(`  Open your browser to view your database`);

    // Write port to file for CLI to read
    fs.writeFileSync(PORT_FILE, actualPort.toString());
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    if (fs.existsSync(PORT_FILE)) {
      try {
        fs.unlinkSync(PORT_FILE);
      } catch (e) {
        // Ignore removal errors
      }
    }
    closePool().then(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startServer };

