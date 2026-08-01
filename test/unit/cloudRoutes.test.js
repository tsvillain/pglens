/**
 * Integration test for the local loopback-OAuth client + cloud proxy routes
 * (routes/cloud.js), against a real pglens core server and a fake
 * pglens-cloud (plain node:http). No real Postgres needed — none of this
 * touches req.pool. Sandboxed HOME so keychain/file state and the cloud
 * session never touch the real machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-cloudroutes-test-'));
process.env.HOME = sandbox;
process.env.PGLENS_SECRET_STORE = 'file';
process.env.PGLENS_LOG_LEVEL = 'warn';

const { startServer } = require('../../src/server');
const { loadOrCreateToken } = require('../../src/auth');

let fakeCloud;
let coreBase;
let token;
let jar = '';
let lastCheckoutBody;
let lastPortalBody;

function respondJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test.before(async () => {
  fakeCloud = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url;

      if (req.method === 'POST' && url === '/auth/token') {
        if (body.code !== 'valid-code') return respondJson(res, 400, { error: { code: 'INVALID_CODE', message: 'bad code' } });
        return respondJson(res, 200, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 });
      }
      if (req.method === 'GET' && url === '/auth/me') {
        return respondJson(res, 200, { user: { id: '22222222-2222-2222-2222-222222222222', email: 'teammate@example.com' } });
      }
      if (req.method === 'GET' && url === '/workspaces') {
        return respondJson(res, 200, { workspaces: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Acme' }] });
      }
      if (req.method === 'GET' && url === '/workspaces/11111111-1111-1111-1111-111111111111/members') {
        return respondJson(res, 200, { members: [{ id: '22222222-2222-2222-2222-222222222222', email: 'teammate@example.com', access_level: 'owner' }] });
      }
      if (req.method === 'PATCH' && url === '/workspaces/11111111-1111-1111-1111-111111111111/members/33333333-3333-3333-3333-333333333333') {
        return respondJson(res, 200, { member: { user_id: '33333333-3333-3333-3333-333333333333', access_level: body.accessLevel } });
      }
      if (req.method === 'POST' && url === '/workspaces/11111111-1111-1111-1111-111111111111/invites') {
        return respondJson(res, 201, { inviteUrl: 'http://fake-cloud/invite/some-token' });
      }
      if (req.method === 'GET' && url === '/workspaces/11111111-1111-1111-1111-111111111111/connections') {
        return respondJson(res, 200, { connections: [] });
      }
      if (req.method === 'POST' && url === '/billing/checkout') {
        lastCheckoutBody = body;
        return respondJson(res, 200, { checkoutUrl: `https://test.checkout.dodopayments.com/session/fake?key=${body.key}` });
      }
      if (req.method === 'POST' && url === '/billing/portal') {
        lastPortalBody = body;
        return respondJson(res, 200, { portalUrl: 'https://portal.dodopayments.com/fake' });
      }
      if (req.method === 'PATCH' && url === '/billing/workspaces/11111111-1111-1111-1111-111111111111/seats') {
        return respondJson(res, 200, { ok: true, seatCount: body.seatCount });
      }
      return respondJson(res, 404, { error: { code: 'NOT_FOUND', message: `no fake route for ${req.method} ${url}` } });
    });
  });
  await new Promise((resolve) => fakeCloud.listen(0, resolve));
  process.env.PGLENS_CLOUD_URL = `http://127.0.0.1:${fakeCloud.address().port}`;

  token = loadOrCreateToken();
  const { port } = await startServer({ standalone: false });
  coreBase = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => fakeCloud.close(resolve));
  // startServer() doesn't hand back the underlying http.Server (only
  // {port, token, url}), so there's no clean handle to close — same
  // pragmatic exit as test/integration/api.test.js.
  setTimeout(() => process.exit(0), 50).unref();
});

// Minimal cookie jar: the token middleware sets pglens_token on first
// query-string auth; every subsequent request rides it back.
async function core(reqPath, init = {}) {
  const headers = new Headers(init.headers || {});
  if (jar) headers.set('cookie', jar);
  const res = await fetch(coreBase + reqPath, { ...init, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar = setCookie.split(';')[0];
  return res;
}

test('establishes the auth cookie', async () => {
  const res = await core(`/api/v3/health`);
  assert.equal(res.status, 200);
  await core(`/?token=${token}`);
  assert.ok(jar.startsWith('pglens_token='));
});

test('GET /api/cloud/status starts signed out', async () => {
  const res = await core('/api/cloud/status');
  const body = await res.json();
  assert.deepEqual(body, { signedIn: false, email: null, workspaceId: null });
});

test('POST /api/cloud/signin returns an authUrl pointing at the fake cloud with our callback as redirect_uri', async () => {
  const res = await core('/api/cloud/signin', { method: 'POST' });
  assert.equal(res.status, 200);
  const { authUrl } = await res.json();
  const url = new URL(authUrl);
  assert.equal(url.pathname, '/auth');
  assert.equal(url.searchParams.get('redirect_uri'), `${coreBase}/api/cloud/callback`);
  assert.ok(url.searchParams.get('state'));
});

test('callback with an unknown/expired state is rejected', async () => {
  const res = await core('/api/cloud/callback?code=valid-code&state=not-a-real-state');
  assert.equal(res.status, 400);
});

test('full sign-in: signin -> callback -> status reflects the signed-in user', async () => {
  const signinRes = await core('/api/cloud/signin', { method: 'POST' });
  const { authUrl } = await signinRes.json();
  const state = new URL(authUrl).searchParams.get('state');

  const callbackRes = await core(`/api/cloud/callback?code=valid-code&state=${state}`);
  assert.equal(callbackRes.status, 302);
  assert.equal(callbackRes.headers.get('location'), '/');

  const statusRes = await core('/api/cloud/status');
  const status = await statusRes.json();
  assert.equal(status.signedIn, true);
  assert.equal(status.email, 'teammate@example.com');
});

test('a state can only be used once', async () => {
  const signinRes = await core('/api/cloud/signin', { method: 'POST' });
  const { authUrl } = await signinRes.json();
  const state = new URL(authUrl).searchParams.get('state');

  const first = await core(`/api/cloud/callback?code=valid-code&state=${state}`);
  assert.equal(first.status, 302);
  const second = await core(`/api/cloud/callback?code=valid-code&state=${state}`);
  assert.equal(second.status, 400);
});

test('workspaces/members/invites all proxy through to the cloud once signed in', async () => {
  const listRes = await core('/api/cloud/workspaces');
  assert.equal((await listRes.json()).workspaces[0].id, '11111111-1111-1111-1111-111111111111');

  const selectRes = await core('/api/cloud/workspaces/11111111-1111-1111-1111-111111111111/select', { method: 'POST' });
  assert.equal(selectRes.status, 200);
  assert.equal((await (await core('/api/cloud/status')).json()).workspaceId, '11111111-1111-1111-1111-111111111111');

  const membersRes = await core('/api/cloud/workspaces/11111111-1111-1111-1111-111111111111/members');
  assert.equal((await membersRes.json()).members[0].access_level, 'owner');

  const patchRes = await core('/api/cloud/workspaces/11111111-1111-1111-1111-111111111111/members/33333333-3333-3333-3333-333333333333', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessLevel: 'write' }),
  });
  assert.equal((await patchRes.json()).member.access_level, 'write');

  const inviteRes = await core('/api/cloud/workspaces/11111111-1111-1111-1111-111111111111/invites', { method: 'POST' });
  assert.equal(inviteRes.status, 201);
  assert.match((await inviteRes.json()).inviteUrl, /invite/);
});

test('the real connectionSource is consulted by the core connections list once signed in', async () => {
  const res = await core('/api/connections');
  assert.equal(res.status, 200);
  // Empty from the fake cloud, but the important thing is the call reached
  // it without error — proves the M1 extension point is actually wired now,
  // not just registered with a no-op.
  assert.deepEqual((await res.json()).connections, []);
});

test('billing checkout/portal/seats all proxy through to the cloud once signed in', async () => {
  // Neither request sends a returnUrl — the client no longer builds one (it
  // can't: the per-install token lives in an HttpOnly cookie). The server
  // must construct it, embedding the token, so Dodo's cross-site redirect
  // back can re-authenticate the same way the CLI's own printed URL does.
  const checkoutRes = await core('/api/cloud/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'pro_monthly' }),
  });
  assert.equal(checkoutRes.status, 200);
  assert.match((await checkoutRes.json()).checkoutUrl, /pro_monthly/);
  const checkoutReturn = new URL(lastCheckoutBody.returnUrl);
  assert.equal(checkoutReturn.pathname, '/cloud');
  assert.equal(checkoutReturn.searchParams.get('token'), token);
  assert.equal(checkoutReturn.searchParams.get('checkout'), 'return');

  const portalRes = await core('/api/cloud/billing/portal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(portalRes.status, 200);
  assert.match((await portalRes.json()).portalUrl, /portal\.dodopayments\.com/);
  const portalReturn = new URL(lastPortalBody.returnUrl);
  assert.equal(portalReturn.searchParams.get('token'), token);

  const seatsRes = await core('/api/cloud/workspaces/11111111-1111-1111-1111-111111111111/seats', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seatCount: 8 }),
  });
  assert.equal(seatsRes.status, 200);
  assert.equal((await seatsRes.json()).seatCount, 8);
});

test('the billing return URL actually re-authenticates a fresh, cookie-less request (the cross-site-redirect case)', async () => {
  // Simulates exactly what broke live: Dodo's redirect back is a brand new
  // top-level navigation with no pglens_token cookie attached. Fetch the
  // returnUrl with no cookie jar and confirm the token-middleware's
  // query-string path picks it up instead of 401ing.
  const res = await fetch(coreBase + new URL(lastCheckoutBody.returnUrl).pathname + new URL(lastCheckoutBody.returnUrl).search, {
    redirect: 'manual',
  });
  assert.equal(res.status, 302, 'should redirect (cookie set, token stripped from URL) rather than 401');
  const location = new URL(res.headers.get('location'), coreBase);
  assert.equal(location.searchParams.get('token'), null, 'token must not survive into the visible URL');
  assert.equal(location.searchParams.get('checkout'), 'return', 'checkout=return must survive the strip');
});

test('POST /api/cloud/signout clears the session', async () => {
  const res = await core('/api/cloud/signout', { method: 'POST' });
  assert.equal(res.status, 200);
  const status = await (await core('/api/cloud/status')).json();
  assert.equal(status.signedIn, false);
});

test('workspace calls fail cleanly (not a crash) once signed out', async () => {
  const res = await core('/api/cloud/workspaces');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_SIGNED_IN');
});
