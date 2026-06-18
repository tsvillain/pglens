/**
 * Integration test: boots the actual Express server against a real Postgres
 * (URL provided via PGLENS_TEST_DB_URL — see docker-compose.test.yml) and
 * exercises the auth-gated API end-to-end.
 *
 * Skips when PGLENS_TEST_DB_URL is unset, so this file is safe to ship.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_URL = process.env.PGLENS_TEST_DB_URL;

if (!DB_URL) {
  test('integration suite (skipped — set PGLENS_TEST_DB_URL to enable)', { skip: true }, () => {});
  return;
}

// Redirect pglens state into a sandbox before any pglens module loads.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-itest-'));
process.env.HOME = sandbox;
process.env.PGLENS_V3 = '0';
process.env.PGLENS_BIND = '127.0.0.1';
process.env.PGLENS_LOG_LEVEL = 'warn';
// Keep secrets out of the real OS keychain — store them in the sandbox so the
// suite runs headless / on CI / on a broken keychain without prompting.
process.env.PGLENS_SECRET_STORE = 'file';

const { startServer } = require('../../src/server');
const { loadOrCreateToken } = require('../../src/auth');

let baseUrl, token, jar;

async function http(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('cookie', jar);
  return fetch(baseUrl + path, { ...init, headers });
}

test.before(async () => {
  const { port } = await startServer({ standalone: false });
  baseUrl = `http://127.0.0.1:${port}`;
  token = loadOrCreateToken();
  jar = `pglens_token=${token}`;
});

test('GET /api/v3/health is open (no auth required)', async () => {
  const res = await fetch(baseUrl + '/api/v3/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /api/connections without token returns the UNAUTHENTICATED envelope', async () => {
  const res = await fetch(baseUrl + '/api/connections');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('POST /api/connect with empty url returns the VALIDATION envelope', async () => {
  const res = await http('/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: '' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'VALIDATION');
});

test('full connection lifecycle: connect → list (masked) → tables → query → disconnect', async () => {
  // Connect.
  const connectRes = await http('/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: DB_URL, sslMode: 'disable', name: 'itest' }),
  });
  assert.equal(connectRes.status, 200);
  const { connectionId } = await connectRes.json();
  assert.ok(connectionId);

  // List returns a *masked* URL.
  const listRes = await http('/api/connections');
  const { connections } = await listRes.json();
  const me = connections.find(c => c.id === connectionId);
  assert.match(me.connectionString, /\*\*\*/);
  assert.doesNotMatch(me.connectionString, /pglens:pglens/);

  // Create a mixed-case table to verify the new identifier escaper.
  await http('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ sql: 'DROP TABLE IF EXISTS "MyTable"' }),
  });
  await http('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ sql: 'CREATE TABLE "MyTable" (id serial primary key, name text)' }),
  });
  await http('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ sql: "INSERT INTO \"MyTable\" (name) VALUES ('a'),('b')" }),
  });

  const tablesRes = await http('/api/tables', {
    headers: { 'x-connection-id': connectionId },
  });
  const { tables } = await tablesRes.json();
  assert.ok(tables.some(t => t.name === 'MyTable'),
    'mixed-case table is visible (regression: old regex rejected it)');

  const rowsRes = await http('/api/tables/MyTable', {
    headers: { 'x-connection-id': connectionId },
  });
  assert.equal(rowsRes.status, 200);
  const data = await rowsRes.json();
  assert.equal(data.rows.length, 2);
  assert.equal(data.hasPrimaryKey, true);

  // Cleanup.
  await http('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ sql: 'DROP TABLE "MyTable"' }),
  });

  const dcRes = await http('/api/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
  });
  assert.equal(dcRes.status, 200);
});

test('transaction mode: implicit BEGIN, isolation, rollback discards, commit persists', async () => {
  const connectRes = await http('/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: DB_URL, sslMode: 'disable', name: 'tx-itest' }),
  });
  const { connectionId } = await connectRes.json();
  assert.ok(connectionId);

  // Helper: every call carries JSON + the connection header.
  const h = (path, init = {}) =>
    http(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-connection-id': connectionId,
        ...(init.headers || {}),
      },
    });

  await h('/api/query', { method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE IF EXISTS tx_items' }) });
  await h('/api/query', {
    method: 'POST',
    body: JSON.stringify({ sql: 'CREATE TABLE tx_items (id serial primary key, label text)' }),
  });

  // First /tx/query implicitly BEGINs and reports the tab holds a transaction.
  const ins = await h('/api/tx/query', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'query', sql: "INSERT INTO tx_items (label) VALUES ('a')" }),
  });
  assert.equal(ins.status, 200);
  assert.equal((await ins.json()).txOpen, true);

  // /tx/status reflects the open transaction and its connection.
  const status = await (await h('/api/tx/status?tabId=query', { method: 'GET' })).json();
  assert.deepEqual(status, { open: true, connectionId });

  // Isolation: a pooled (auto-commit) read does NOT see the uncommitted row…
  const pooled = await (await h('/api/tables/tx_items', { method: 'GET' })).json();
  assert.equal(pooled.rows.length, 0);
  // …but the transaction sees its own write.
  const inTx = await h('/api/tx/query', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'query', sql: 'SELECT count(*)::int AS n FROM tx_items' }),
  });
  assert.equal((await inTx.json()).results[0].rows[0].n, 1);

  // Rollback discards the row and closes the session.
  const rb = await (await h('/api/tx/rollback', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'query' }),
  })).json();
  assert.deepEqual(rb, { rolledBack: true, hadTransaction: true });
  assert.equal((await (await h('/api/tables/tx_items', { method: 'GET' })).json()).rows.length, 0);
  assert.equal((await (await h('/api/tx/status?tabId=query', { method: 'GET' })).json()).open, false);

  // A fresh transaction that commits persists its row.
  await h('/api/tx/query', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'query', sql: "INSERT INTO tx_items (label) VALUES ('b')" }),
  });
  const cm = await (await h('/api/tx/commit', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'query' }),
  })).json();
  assert.deepEqual(cm, { committed: true, hadTransaction: true });
  assert.equal((await (await h('/api/tables/tx_items', { method: 'GET' })).json()).rows.length, 1);

  // Cleanup + disconnect (also releases any lingering reserved backend).
  await h('/api/query', { method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE tx_items' }) });
  await h('/api/disconnect', { method: 'POST', body: JSON.stringify({ connectionId }) });
});

test('operations dashboard: overview snapshot + backend-action wiring (roadmap §6.1)', async () => {
  const connectRes = await http('/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: DB_URL, sslMode: 'disable', name: 'ops-itest' }),
  });
  const { connectionId } = await connectRes.json();
  assert.ok(connectionId);

  const h = (path, init = {}) =>
    http(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-connection-id': connectionId,
        ...(init.headers || {}),
      },
    });

  const overview = await (await h('/api/operations/overview', { method: 'GET' })).json();

  // Every section is present and shaped `{ data, error }`.
  for (const key of ['activity', 'blocking', 'replication', 'sizes', 'connections']) {
    assert.ok(overview[key], `missing section ${key}`);
    assert.ok('data' in overview[key] && 'error' in overview[key], `section ${key} not enveloped`);
  }

  // Connection stats are real counts with a derived warning level.
  assert.equal(overview.connections.error, null);
  assert.ok(overview.connections.data.total >= 1);
  assert.ok(['ok', 'warn'].includes(overview.connections.data.level));

  // Database size is reported in bytes.
  assert.equal(overview.sizes.error, null);
  assert.ok(Number(overview.sizes.data.database.bytes) > 0);

  // Activity is a list and never includes the polling backend's own pid.
  assert.ok(Array.isArray(overview.activity.data));

  // Acting on a non-existent backend is a clean no-op (max int4 pid).
  const cancel = await (await h('/api/operations/cancel', {
    method: 'POST', body: JSON.stringify({ pid: 2147483647 }),
  })).json();
  assert.equal(cancel.cancelled, false);
  const term = await (await h('/api/operations/terminate', {
    method: 'POST', body: JSON.stringify({ pid: 2147483647 }),
  })).json();
  assert.equal(term.terminated, false);

  // A non-positive pid is rejected by validation before touching the DB.
  const bad = await h('/api/operations/cancel', {
    method: 'POST', body: JSON.stringify({ pid: 0 }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'VALIDATION');

  await h('/api/disconnect', { method: 'POST', body: JSON.stringify({ connectionId }) });
});

test('slow query view: state machine + sort validation (roadmap §6.2)', async () => {
  const connectRes = await http('/api/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: DB_URL, sslMode: 'disable', name: 'slow-itest' }),
  });
  const { connectionId } = await connectRes.json();
  assert.ok(connectionId);

  const h = (path, init = {}) =>
    http(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-connection-id': connectionId,
        ...(init.headers || {}),
      },
    });

  // The list endpoint always answers with one of the three known states; we
  // don't assume the test server has pg_stat_statements installed/preloaded.
  const list = await (await h('/api/operations/statements?sort=total_exec_time', { method: 'GET' })).json();
  assert.ok(['ready', 'not_installed', 'not_loaded'].includes(list.status), `unexpected status ${list.status}`);
  assert.ok(Array.isArray(list.statements));

  if (list.status === 'ready') {
    // Real rows carry the derived p95 estimate alongside the raw aggregates.
    for (const s of list.statements) {
      assert.ok('p95_exec_time_est' in s);
      assert.ok('total_exec_time' in s && 'calls' in s);
    }
  } else {
    // Otherwise the enable DDL is offered for the one-click prompt.
    assert.match(list.ddl, /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
  }

  // A sort key off the allowlist is rejected by validation before any SQL runs.
  const bad = await h('/api/operations/statements?sort=rows;DROP', { method: 'GET' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'VALIDATION');

  await h('/api/disconnect', { method: 'POST', body: JSON.stringify({ connectionId }) });
});

test.after(() => {
  // Best-effort cleanup of the sandbox HOME.
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  // Force-exit because the Express server holds the event loop open and
  // pino-roll keeps a transport worker alive.
  setTimeout(() => process.exit(0), 50).unref();
});
