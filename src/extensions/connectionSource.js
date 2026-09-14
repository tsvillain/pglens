/**
 * Connection-source adapter extension point.
 *
 * Core lists connections from the local `connections.json` only. Additional
 * sources can register here at startup — e.g. connections shared by a team
 * — and `getConnections()` (src/db/connection.js) merges their records into
 * the list alongside local ones. Nothing is registered by default, so
 * behavior is unchanged out of the box.
 *
 * A source is `{ name, listExternal(): Promise<ConnectionRecord[]> }`.
 * `ConnectionRecord` matches the shape `getConnections()` already returns
 * (id, name, host, port, database, username, connectionString, sslMode, schema).
 */

const logger = require('../log');

const sources = [];

function registerConnectionSource(source) {
  if (!source || typeof source.listExternal !== 'function') {
    throw new Error('connection source must implement listExternal()');
  }
  sources.push(source);
}

async function listExternalConnections() {
  const lists = await Promise.all(
    sources.map((s) =>
      Promise.resolve(s.listExternal()).catch((err) => {
        logger.warn({ err: err.message, source: s.name }, 'connection source list failed');
        return [];
      }),
    ),
  );
  return lists.flat();
}

/** Test-only — drop all registered sources. */
function _resetForTests() {
  sources.length = 0;
}

module.exports = { registerConnectionSource, listExternalConnections, _resetForTests };
