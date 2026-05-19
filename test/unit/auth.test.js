const test = require('node:test');
const assert = require('node:assert/strict');

const { createTokenMiddleware, COOKIE_NAME } = require('../../src/auth');

const EXPECTED = 'a'.repeat(64);

function buildReq({ cookies = {}, headers = {}, query = {}, method = 'GET', html = false, originalUrl = '/' } = {}) {
  return {
    cookies, headers, query, method, originalUrl,
    get(name) { return headers[name.toLowerCase()]; },
    accepts() { return html; },
  };
}

function buildRes() {
  return {
    statusCode: 200,
    body: null,
    cookies: {},
    redirectTo: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    cookie(name, value) { this.cookies[name] = value; },
    redirect(code, url) { this.statusCode = code; this.redirectTo = url; },
  };
}

test('passes through with a valid cookie', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq({ cookies: { [COOKIE_NAME]: EXPECTED } });
  const res = buildRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('passes through with a valid x-pglens-token header', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq({ headers: { 'x-pglens-token': EXPECTED } });
  const res = buildRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('redirects 302 with cookie set when token in query (browser)', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq({ query: { token: EXPECTED }, html: true, originalUrl: '/v3/?token=' + EXPECTED });
  const res = buildRes();
  mw(req, res, () => { throw new Error('should not pass through on browser redirect'); });
  assert.equal(res.statusCode, 302);
  assert.equal(res.redirectTo, '/v3/');
  assert.equal(res.cookies[COOKIE_NAME], EXPECTED);
});

test('passes through (non-browser) when token in query — no redirect', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq({ query: { token: EXPECTED } });
  const res = buildRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.cookies[COOKIE_NAME], EXPECTED);
});

test('rejects with 401 UNAUTHENTICATED envelope when nothing matches', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq();
  const res = buildRes();
  mw(req, res, () => { throw new Error('should not pass through'); });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
});

test('rejects with mismatched token of equal length (constant-time)', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq({ headers: { 'x-pglens-token': 'b'.repeat(EXPECTED.length) } });
  const res = buildRes();
  mw(req, res, () => { throw new Error('should not pass through'); });
  assert.equal(res.statusCode, 401);
});

test('rejects with mismatched token of different length', () => {
  const mw = createTokenMiddleware(EXPECTED);
  const req = buildReq({ headers: { 'x-pglens-token': 'short' } });
  const res = buildRes();
  mw(req, res, () => { throw new Error('should not pass through'); });
  assert.equal(res.statusCode, 401);
});
