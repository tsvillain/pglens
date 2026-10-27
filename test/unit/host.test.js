const test = require('node:test');
const assert = require('node:assert/strict');

const { loadHostConfig } = require('../../src/config/host');

test('defaults to loopback, no fixed port, plain cookie', () => {
  const c = loadHostConfig({});
  assert.equal(c.bindHost, '127.0.0.1');
  assert.equal(c.fixedPort, null);
  assert.equal(c.secureCookie, false);
  assert.ok(!c.allowedHosts.has('db.example.com'));
  assert.equal(c.displayUrl(54321, 'tok'), 'http://127.0.0.1:54321/?token=tok');
});

test('public URL allows its hostname, secures the cookie, and is printed', () => {
  const c = loadHostConfig({
    PGLENS_BIND: '0.0.0.0',
    PGLENS_PORT: '8080',
    PGLENS_PUBLIC_URL: 'https://DB.Example.com',
  });
  assert.equal(c.fixedPort, 8080);
  assert.ok(c.allowedHosts.has('db.example.com'));
  assert.ok(c.allowedHosts.has('localhost'));
  assert.equal(c.secureCookie, true);
  assert.equal(c.displayUrl(8080, 'tok'), 'https://db.example.com/?token=tok');
  assert.equal(c.displayUrl(8080), 'https://db.example.com');
});

test('http public URL keeps the cookie non-secure', () => {
  assert.equal(loadHostConfig({ PGLENS_PUBLIC_URL: 'http://pglens.lan' }).secureCookie, false);
});

test('rejects bad values at boot', () => {
  for (const PGLENS_PORT of ['abc', '0', '70000', '1.5']) {
    assert.throws(() => loadHostConfig({ PGLENS_PORT }), /PGLENS_PORT/);
  }
  for (const PGLENS_PUBLIC_URL of ['db.example.com', 'ftp://db.example.com', 'https://example.com/pglens']) {
    assert.throws(() => loadHostConfig({ PGLENS_PUBLIC_URL }), /PGLENS_PUBLIC_URL/);
  }
});
