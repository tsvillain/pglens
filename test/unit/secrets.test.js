const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseConnectionUrl,
  buildConnectionUrl,
  maskedConnectionUrl,
} = require('../../src/db/secrets');

test('parseConnectionUrl extracts standard fields', () => {
  const meta = parseConnectionUrl('postgresql://alice:s3cret@localhost:5433/mydb');
  assert.equal(meta.protocol, 'postgresql');
  assert.equal(meta.username, 'alice');
  assert.equal(meta.password, 's3cret');
  assert.equal(meta.host, 'localhost');
  assert.equal(meta.port, 5433);
  assert.equal(meta.database, 'mydb');
});

test('parseConnectionUrl defaults the port to 5432', () => {
  const meta = parseConnectionUrl('postgres://u:p@h/d');
  assert.equal(meta.port, 5432);
});

test('parseConnectionUrl decodes percent-encoded credentials', () => {
  const meta = parseConnectionUrl('postgresql://a%40b:p%40ss@h:5432/d');
  assert.equal(meta.username, 'a@b');
  assert.equal(meta.password, 'p@ss');
});

test('parseConnectionUrl returns null for garbage', () => {
  assert.equal(parseConnectionUrl('not a url'), null);
});

test('parseConnectionUrl captures query params', () => {
  const meta = parseConnectionUrl('postgresql://u:p@h:5432/d?sslmode=require&application_name=pglens');
  assert.deepEqual(meta.params, { sslmode: 'require', application_name: 'pglens' });
});

test('buildConnectionUrl round-trips the password', () => {
  const meta = parseConnectionUrl('postgresql://u:p@h:5432/d');
  const password = meta.password;
  delete meta.password;
  assert.equal(buildConnectionUrl(meta, password), 'postgresql://u:p@h:5432/d');
});

test('buildConnectionUrl encodes special characters in credentials', () => {
  const meta = { protocol: 'postgresql', username: 'a@b', host: 'h', port: 5432, database: 'd' };
  assert.equal(buildConnectionUrl(meta, 'p@ss/word'), 'postgresql://a%40b:p%40ss%2Fword@h:5432/d');
});

test('maskedConnectionUrl never contains the password', () => {
  const meta = { protocol: 'postgresql', username: 'alice', host: 'h', port: 5432, database: 'd', password: 'leak-me' };
  const url = maskedConnectionUrl(meta);
  assert.match(url, /\*\*\*/);
  assert.doesNotMatch(url, /leak-me/);
});
