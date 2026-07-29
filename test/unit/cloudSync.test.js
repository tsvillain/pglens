/**
 * Unit tests for the real connectionSource/syncAdapter implementations
 * (src/cloud/sync.js) — the pieces that actually call pglens-cloud. Runs
 * against a tiny fake HTTP server standing in for pglens-cloud, and a
 * sandboxed HOME so keychain/file state never touches the real machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-cloudsync-test-'));
process.env.HOME = sandbox;
process.env.PGLENS_SECRET_STORE = 'file';

const session = require('../../src/cloud/session');
const { cloudConnectionSource, cloudSyncAdapter } = require('../../src/cloud/sync');

let fakeCloud;
let requests;

test.before(async () => {
  requests = [];
  fakeCloud = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });

      if (req.method === 'GET' && req.url === '/workspaces/ws-1/connections') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          connections: [{
            id: 'conn-1', name: 'prod', host: 'db.internal', port: 5432,
            database: 'app', username: 'app_ro', ssl_mode: 'require', schema_name: 'public',
          }],
        }));
      }
      if (req.method === 'PUT' && req.url === '/workspaces/ws-1/connections') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ connection: { id: 'conn-2', ...JSON.parse(body) } }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }));
    });
  });
  await new Promise((resolve) => fakeCloud.listen(0, resolve));
  process.env.PGLENS_CLOUD_URL = `http://127.0.0.1:${fakeCloud.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => fakeCloud.close(resolve));
});

test.beforeEach(() => {
  requests.length = 0;
});

test('connectionSource.listExternal returns [] with no session — never throws', async () => {
  await session.clearSession();
  const result = await cloudConnectionSource.listExternal();
  assert.deepEqual(result, []);
  assert.equal(requests.length, 0, 'should not even call the cloud without a selected workspace');
});

test('connectionSource.listExternal fetches and maps the workspace connections', async () => {
  await session.setSession({ email: 'x@example.com', accessToken: 'tok', refreshToken: 'ref' });
  session.setWorkspaceId('ws-1');

  const result = await cloudConnectionSource.listExternal();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'conn-1');
  assert.equal(result[0].host, 'db.internal');
  assert.equal(result[0].sslMode, 'require');
  assert.equal(result[0].schema, 'public');
  assert.equal(requests[0].url, '/workspaces/ws-1/connections');
});

test('connectionSource.listExternal degrades to [] on a cloud/network error, never throws', async () => {
  await session.setSession({ email: 'x@example.com', accessToken: 'tok', refreshToken: 'ref' });
  session.setWorkspaceId('does-not-exist');
  const result = await cloudConnectionSource.listExternal();
  assert.deepEqual(result, []);
});

test('syncAdapter.notify is a no-op for non-connection kinds and with no workspace selected', async () => {
  await session.clearSession();
  await assert.doesNotReject(cloudSyncAdapter.notify('view', { id: 'v1' }));
  assert.equal(requests.length, 0);

  await session.setSession({ email: 'x@example.com', accessToken: 'tok', refreshToken: 'ref' });
  await assert.doesNotReject(cloudSyncAdapter.notify('connection', [{ id: 'c1', name: 'x', meta: {} }]));
  assert.equal(requests.length, 0, 'no workspace selected — should skip the cloud entirely');
});

test('syncAdapter.notify pushes each local connection record to the workspace', async () => {
  await session.setSession({ email: 'x@example.com', accessToken: 'tok', refreshToken: 'ref' });
  session.setWorkspaceId('ws-1');

  const localSnapshot = [{
    id: 'c1', name: 'prod', sslMode: 'require', schema: 'public',
    meta: { host: 'db.internal', port: 5432, database: 'app', username: 'app_ro' },
  }];
  await cloudSyncAdapter.notify('connection', localSnapshot);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].body.host, 'db.internal');
  assert.equal(requests[0].body.name, 'prod');
});
