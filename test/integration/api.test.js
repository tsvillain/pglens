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

test.after(() => {
  // Best-effort cleanup of the sandbox HOME.
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  // Force-exit because the Express server holds the event loop open and
  // pino-roll keeps a transport worker alive.
  setTimeout(() => process.exit(0), 50).unref();
});
