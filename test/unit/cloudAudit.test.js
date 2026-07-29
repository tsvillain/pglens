/**
 * Unit tests for src/cloud/audit.js. classifyStatement is a lexical guess
 * (not a parser, same ponytail note as src/db/statements.js) — these check
 * the common shapes it needs to get right, not exhaustive SQL coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-cloudaudit-test-'));
process.env.HOME = sandbox;
process.env.PGLENS_SECRET_STORE = 'file';

const session = require('../../src/cloud/session');
const { reportEvent, classifyStatement } = require('../../src/cloud/audit');

// fetch()'s keep-alive socket to the server doesn't close on its own, so a
// plain server.close() hangs forever waiting for it — force it.
function closeServer(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  return closed;
}

test('classifyStatement recognizes SELECT/INSERT/UPDATE/DELETE and their table', () => {
  assert.deepEqual(classifyStatement('SELECT * FROM orders WHERE id = 1'), { statementKind: 'select', tableName: 'orders' });
  assert.deepEqual(classifyStatement('insert into users (email) values ($1)'), { statementKind: 'insert', tableName: 'users' });
  assert.deepEqual(classifyStatement('UPDATE "Orders" SET status = $1'), { statementKind: 'update', tableName: 'Orders' });
  assert.deepEqual(classifyStatement('delete from sessions where expired'), { statementKind: 'delete', tableName: 'sessions' });
});

test('classifyStatement maps CREATE/ALTER/DROP to ddl', () => {
  assert.equal(classifyStatement('CREATE TABLE foo (id int)').statementKind, 'ddl');
  assert.equal(classifyStatement('ALTER TABLE foo ADD COLUMN bar text').statementKind, 'ddl');
  assert.equal(classifyStatement('DROP INDEX foo_idx').statementKind, 'ddl');
});

test('classifyStatement strips a leading "public." schema qualifier', () => {
  assert.equal(classifyStatement('SELECT * FROM public.orders').tableName, 'orders');
});

test('classifyStatement falls back to "other" with no table for anything unrecognized', () => {
  assert.deepEqual(classifyStatement('BEGIN'), { statementKind: 'other', tableName: null });
  assert.deepEqual(classifyStatement(''), { statementKind: 'other', tableName: null });
});

test('reportEvent is a no-op with no workspace selected — never throws', async () => {
  await session.clearSession();
  let hit = false;
  const server = http.createServer((req, res) => { hit = true; res.writeHead(200).end('{}'); });
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    process.env.PGLENS_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;

    assert.doesNotThrow(() => reportEvent({ connectionId: 'c1', statementKind: 'select', tableName: 'x' }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hit, false, 'should never even reach the network without a selected workspace');
  } finally {
    await closeServer(server);
  }
});

test('reportEvent posts to the workspace audit endpoint when a workspace is selected', async () => {
  await session.setSession({ email: 'x@example.com', accessToken: 'tok', refreshToken: 'ref' });
  session.setWorkspaceId('ws-1');

  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = { url: req.url, body: JSON.parse(body) };
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    process.env.PGLENS_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;

    reportEvent({ connectionId: 'c1', statementKind: 'update', tableName: 'orders' });
    // Fire-and-forget — poll instead of a fixed sleep so this isn't flaky
    // under load, and fails fast with a clear reason instead of hanging.
    for (let i = 0; i < 50 && !captured; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(captured, 'reportEvent never reached the fake cloud server within 500ms');
    assert.equal(captured.url, '/workspaces/ws-1/audit');
    assert.equal(captured.body.statementKind, 'update');
    assert.equal(captured.body.tableName, 'orders');
  } finally {
    await closeServer(server);
  }
});
