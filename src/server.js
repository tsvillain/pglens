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
function startServer() {
  const app = express();
  const port = 54321;

  app.use(cors());
  app.use(express.json());

  app.use('/api', apiRoutes);

  const clientPath = path.join(__dirname, '../client');
  app.use(express.static(clientPath));

  app.get('*', (_, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });

  app.listen(port, () => {
    console.log(`✓ Server running on http://localhost:${port}`);
    console.log(`  Open your browser to view your database`);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    closePool().then(() => {
      process.exit(0);
    });
  });
}

module.exports = { startServer };

