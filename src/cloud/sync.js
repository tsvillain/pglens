/**
 * Real implementations of the M1 extension points, backed by pglens-cloud.
 * Registered unconditionally at server startup — both degrade to a no-op
 * (empty list / silent skip) whenever there's no session or no selected
 * workspace, so registering them doesn't require knowing sign-in state at
 * startup, and a cloud outage never breaks local use (local-first —
 * COMMERCIALIZATION.md §6: "works when cloud is down").
 */

const logger = require('../log');
const session = require('./session');
const client = require('./client');
const { registerConnectionSource } = require('../extensions/connectionSource');
const { setSyncAdapter } = require('../extensions/syncAdapter');

const cloudConnectionSource = {
  name: 'pglens-cloud',
  async listExternal() {
    const workspaceId = session.getWorkspaceId();
    if (!workspaceId) return [];
    try {
      const { connections } = await client.request(`/workspaces/${workspaceId}/connections`);
      return connections.map((c) => ({
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        database: c.database,
        username: c.username,
        connectionString: undefined,
        sslMode: c.ssl_mode,
        schema: c.schema_name,
      }));
    } catch (err) {
      logger.warn({ err: err.message }, 'cloud connection sync: list failed');
      return [];
    }
  },
};

const cloudSyncAdapter = {
  name: 'pglens-cloud',
  async notify(kind, record) {
    if (kind !== 'connection') return;
    const workspaceId = session.getWorkspaceId();
    if (!workspaceId) return;

    // `record` is the full local connections.json snapshot (array). Push
    // each one — cloud connections only track metadata, never the password.
    const list = Array.isArray(record) ? record : [];
    for (const conn of list) {
      await client.request(`/workspaces/${workspaceId}/connections`, {
        method: 'PUT',
        body: {
          id: conn.id,
          name: conn.name,
          host: conn.meta?.host,
          port: conn.meta?.port,
          database: conn.meta?.database,
          username: conn.meta?.username,
          sslMode: conn.sslMode,
          schema: conn.schema,
        },
      });
    }
  },
};

function register() {
  registerConnectionSource(cloudConnectionSource);
  setSyncAdapter(cloudSyncAdapter);
}

module.exports = { register, cloudConnectionSource, cloudSyncAdapter };
