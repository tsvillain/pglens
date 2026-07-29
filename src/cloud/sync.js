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
const { registerViewSource } = require('../extensions/viewSource');
const { registerSavedQuerySource } = require('../extensions/savedQuerySource');
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

const cloudViewSource = {
  name: 'pglens-cloud',
  async listExternal() {
    const workspaceId = session.getWorkspaceId();
    if (!workspaceId) return [];
    try {
      const { views } = await client.request(`/workspaces/${workspaceId}/views`);
      return views.map((v) => ({
        id: v.id,
        connectionId: v.connection_id,
        tableName: v.table_name,
        name: v.name,
        filter: v.filter,
        sort: v.sort,
        visibleColumns: v.visible_columns,
        columnWidths: v.column_widths,
        timezone: v.timezone,
      }));
    } catch (err) {
      logger.warn({ err: err.message }, 'cloud view sync: list failed');
      return [];
    }
  },
};

const cloudSavedQuerySource = {
  name: 'pglens-cloud',
  async listExternal() {
    const workspaceId = session.getWorkspaceId();
    if (!workspaceId) return [];
    try {
      const { savedQueries } = await client.request(`/workspaces/${workspaceId}/saved-queries`);
      return savedQueries.map((q) => ({
        id: q.id,
        connectionId: q.connection_id,
        name: q.name,
        sql: q.sql,
        folder: q.folder,
        tags: q.tags ?? [],
      }));
    } catch (err) {
      logger.warn({ err: err.message }, 'cloud saved query sync: list failed');
      return [];
    }
  },
};

async function pushConnections(workspaceId, record) {
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
}

// ponytail: a view/query against a connection not yet synced to this
// workspace fails the cloud-side foreign key — caught by notify()'s callers
// (extensions/syncAdapter.js logs a warning, never throws to the caller).
// No ordering guarantee between connection- and view-sync yet; add one if
// this turns out to bite in practice.
async function pushView(workspaceId, view) {
  if (view.deleted) {
    await client.request(`/workspaces/${workspaceId}/views/${view.id}`, { method: 'DELETE' });
    return;
  }
  await client.request(`/workspaces/${workspaceId}/views`, {
    method: 'PUT',
    body: {
      id: view.id,
      connectionId: view.connectionId,
      tableName: view.tableName,
      name: view.name,
      filter: view.filter,
      sort: view.sort,
      visibleColumns: view.visibleColumns,
      columnWidths: view.columnWidths,
      timezone: view.timezone,
    },
  });
}

async function pushSavedQuery(workspaceId, query) {
  if (query.deleted) {
    await client.request(`/workspaces/${workspaceId}/saved-queries/${query.id}`, { method: 'DELETE' });
    return;
  }
  await client.request(`/workspaces/${workspaceId}/saved-queries`, {
    method: 'PUT',
    body: {
      id: query.id,
      connectionId: query.connectionId,
      name: query.name,
      sql: query.sql,
      folder: query.folder,
      tags: query.tags,
    },
  });
}

const cloudSyncAdapter = {
  name: 'pglens-cloud',
  async notify(kind, record) {
    const workspaceId = session.getWorkspaceId();
    if (!workspaceId) return;

    if (kind === 'connection') return pushConnections(workspaceId, record);
    if (kind === 'view') return pushView(workspaceId, record);
    if (kind === 'savedQuery') return pushSavedQuery(workspaceId, record);
  },
};

function register() {
  registerConnectionSource(cloudConnectionSource);
  registerViewSource(cloudViewSource);
  registerSavedQuerySource(cloudSavedQuerySource);
  setSyncAdapter(cloudSyncAdapter);
}

module.exports = {
  register,
  cloudConnectionSource,
  cloudViewSource,
  cloudSavedQuerySource,
  cloudSyncAdapter,
};
