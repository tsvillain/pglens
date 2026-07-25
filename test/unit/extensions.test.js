/**
 * Unit tests for the extensions panel (roadmap §7.4).
 *
 * Mirrors slowQueries.test.js: a fake pool returns canned rows by SQL substring
 * so we can assert the list mapping, the superuser flag, the install-name guard,
 * and the quoted CREATE EXTENSION without a live Postgres.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { listExtensions, installExtension, dropExtension } = require('../../src/db/extensions');

function fakePool(matchers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [needle, rows] of matchers) {
        if (sql.includes(needle)) {
          if (rows instanceof Error) throw rows;
          return { rows, fields: [], rowCount: rows.length, command: 'SELECT' };
        }
      }
      return { rows: [], fields: [], rowCount: 0, command: 'SELECT' };
    },
  };
}

test('listExtensions maps rows, derives installed, flags popular + superuser', async () => {
  const pool = fakePool([
    ['FROM pg_available_extensions', [
      { name: 'hstore', default_version: '1.8', installed_version: '1.8', comment: 'key/value' },
      { name: 'zztop', default_version: '2.0', installed_version: null, comment: null },
    ]],
    ['is_superuser', [{ superuser: 'on' }]],
  ]);
  const { superuser, extensions } = await listExtensions(pool);
  assert.equal(superuser, true);
  assert.deepEqual(extensions[0], {
    name: 'hstore', installedVersion: '1.8', defaultVersion: '1.8',
    comment: 'key/value', installed: true, popular: true,
  });
  assert.equal(extensions[1].installed, false);
  assert.equal(extensions[1].popular, false);
});

test('listExtensions reports superuser:false when is_superuser is off', async () => {
  const pool = fakePool([
    ['FROM pg_available_extensions', []],
    ['is_superuser', [{ superuser: 'off' }]],
  ]);
  assert.equal((await listExtensions(pool)).superuser, false);
});

test('installExtension rejects a name the server does not offer', async () => {
  // The availability probe returns no row → NOT_AVAILABLE, nothing is created.
  const pool = fakePool([['FROM pg_available_extensions WHERE name', []]]);
  await assert.rejects(() => installExtension(pool, 'definitely_not_real'), /not available/);
  assert.ok(!pool.calls.some((c) => c.sql.includes('CREATE EXTENSION')));
});

test('installExtension runs a quoted CREATE EXTENSION and returns refreshed status', async () => {
  const pool = fakePool([
    ['FROM pg_available_extensions WHERE name', [{ installed_version: '1.6' }]],
  ]);
  const result = await installExtension(pool, 'pg_trgm');
  assert.deepEqual(result, { installed: true, installedVersion: '1.6' });
  const ddl = pool.calls.find((c) => c.sql.includes('CREATE EXTENSION'));
  assert.match(ddl.sql, /^CREATE EXTENSION IF NOT EXISTS "pg_trgm"$/);
});

test('installExtension quotes a name with a double quote (no injection)', async () => {
  const pool = fakePool([
    ['FROM pg_available_extensions WHERE name', [{ installed_version: null }]],
  ]);
  await installExtension(pool, 'a"b');
  const ddl = pool.calls.find((c) => c.sql.includes('CREATE EXTENSION'));
  assert.match(ddl.sql, /CREATE EXTENSION IF NOT EXISTS "a""b"$/);
});

test('dropExtension runs a quoted DROP ... IF EXISTS (RESTRICT, no CASCADE)', async () => {
  const pool = fakePool([
    ['FROM pg_available_extensions WHERE name', [{ installed_version: null }]],
  ]);
  const result = await dropExtension(pool, 'hstore');
  assert.deepEqual(result, { installed: false, installedVersion: null });
  const ddl = pool.calls.find((c) => c.sql.includes('DROP EXTENSION'));
  assert.match(ddl.sql, /^DROP EXTENSION IF EXISTS "hstore"$/);
  assert.doesNotMatch(ddl.sql, /CASCADE/);
});

test('dropExtension rejects a name the server does not offer', async () => {
  const pool = fakePool([['FROM pg_available_extensions WHERE name', []]]);
  await assert.rejects(() => dropExtension(pool, 'definitely_not_real'), /not available/);
  assert.ok(!pool.calls.some((c) => c.sql.includes('DROP EXTENSION')));
});
