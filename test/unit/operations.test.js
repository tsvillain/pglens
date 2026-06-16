/**
 * Unit tests for the live activity dashboard (roadmap §6.1).
 *
 * The readers take the wrapped pool and call `pool.query(sql, params)`, so a
 * fake pool lets us assert the per-section wiring, the 80% warning threshold,
 * and getOverview()'s "one bad section degrades, the rest survive" contract
 * without a live Postgres.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getOverview,
  getConnectionStats,
  cancelBackend,
  terminateBackend,
  connectionUsageLevel,
} = require('../../src/db/operations');

// A fake pool whose query() returns canned rows by matching a substring of the
// SQL, and records every (sql, params) call.
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

test('connectionUsageLevel warns at 80% of max', () => {
  assert.equal(connectionUsageLevel(79, 100), 'ok');
  assert.equal(connectionUsageLevel(80, 100), 'warn');
  assert.equal(connectionUsageLevel(100, 100), 'warn');
  // Unknown / zero max never warns (avoids a divide-by-zero false alarm).
  assert.equal(connectionUsageLevel(50, 0), 'ok');
  assert.equal(connectionUsageLevel(50, null), 'ok');
});

test('getConnectionStats attaches a derived warning level', async () => {
  const pool = fakePool([
    ['FROM pg_stat_activity', [{ total: 90, active: 10, idle: 80, max: 100, reserved: 3 }]],
  ]);
  const stats = await getConnectionStats(pool);
  assert.equal(stats.total, 90);
  assert.equal(stats.level, 'warn');
});

test('getOverview isolates a failing section', async () => {
  const pool = fakePool([
    ['FROM pg_stat_replication', new Error('permission denied for pg_stat_replication')],
    ['FROM pg_stat_activity', [{ total: 5, max: 100 }]],
    ['pg_database_size', [{ name: 'db', bytes: 1, pretty: '1 byte' }]],
  ]);
  const overview = await getOverview(pool, 'public');

  // Replication blew up — captured, not thrown.
  assert.equal(overview.replication.data, null);
  assert.match(overview.replication.error, /permission denied/);

  // Other sections still resolved with data and no error.
  assert.equal(overview.connections.error, null);
  assert.equal(overview.connections.data.level, 'ok');
  assert.equal(overview.activity.error, null);
  assert.ok(Array.isArray(overview.activity.data));
});

test('getOverview passes the schema through to the size reader', async () => {
  const pool = fakePool([['pg_database_size', [{ name: 'db', bytes: 1, pretty: '1 byte' }]]]);
  await getOverview(pool, 'analytics');
  const sizeCall = pool.calls.find((c) => c.sql.includes('pg_total_relation_size'));
  assert.ok(sizeCall, 'expected a table-size query');
  assert.equal(sizeCall.params[0], 'analytics');
});

test('cancel / terminate map pg_*_backend boolean to a named flag', async () => {
  const cancelPool = fakePool([['pg_cancel_backend', [{ ok: true }]]]);
  assert.deepEqual(await cancelBackend(cancelPool, 42), { cancelled: true });
  assert.equal(cancelPool.calls[0].params[0], 42);

  const termPool = fakePool([['pg_terminate_backend', [{ ok: false }]]]);
  assert.deepEqual(await terminateBackend(termPool, 99), { terminated: false });
});
