/**
 * Unit tests for the slow query view (roadmap §6.2).
 *
 * Mirrors operations.test.js: a fake pool returns canned rows by SQL substring
 * so we can assert the status state-machine, the sort allowlist, the row-limit
 * clamp, and the p95 estimate without a live Postgres + pg_stat_statements.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getStatements,
  enableStatements,
  resetStatements,
  estimateP95,
  sortColumn,
  rowLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require('../../src/db/slowQueries');

// Canned rows by SQL substring; records every (sql, params) call. An Error
// value is thrown when matched, to exercise the not_loaded / failure paths.
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

test('estimateP95 = mean + 1.6449·stddev, clamped to [mean, max]', () => {
  // Normal case: mean 100, stddev 20 → 100 + 1.6449*20 = 132.898, under max.
  assert.ok(Math.abs(estimateP95(100, 20, 1000) - 132.898) < 0.01);
  // Clamped up to the mean when stddev would pull it below (never happens with
  // a non-negative stddev, but a missing stddev falls back to the mean).
  assert.equal(estimateP95(50, null, 1000), 50);
  // Clamped down to the observed max.
  assert.equal(estimateP95(100, 1000, 120), 120);
  // Unknown mean → null (nothing to estimate from).
  assert.equal(estimateP95(null, 20, 100), null);
  assert.equal(estimateP95(undefined, 20, 100), null);
});

test('sortColumn only ever yields an allowlisted column', () => {
  assert.equal(sortColumn('total_exec_time'), 'total_exec_time');
  assert.equal(sortColumn('mean_exec_time'), 'mean_exec_time');
  assert.equal(sortColumn('calls'), 'calls');
  // Anything off the list (including an injection attempt) collapses to the default.
  assert.equal(sortColumn('rows; DROP TABLE x'), 'total_exec_time');
  assert.equal(sortColumn(undefined), 'total_exec_time');
});

test('rowLimit clamps to [1, MAX_LIMIT] and defaults when unset', () => {
  assert.equal(rowLimit(undefined), DEFAULT_LIMIT);
  assert.equal(rowLimit(0), DEFAULT_LIMIT);
  assert.equal(rowLimit(-5), DEFAULT_LIMIT);
  assert.equal(rowLimit(10), 10);
  assert.equal(rowLimit(99999), MAX_LIMIT);
});

test('getStatements reports not_installed when the extension is absent', async () => {
  const pool = fakePool([['pg_available_extensions', [{ installed: false, available: true }]]]);
  const result = await getStatements(pool, { sort: 'calls' });
  assert.equal(result.status, 'not_installed');
  assert.equal(result.available, true);
  assert.match(result.ddl, /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
  assert.deepEqual(result.statements, []);
  // It short-circuits before ever touching the stats view.
  assert.ok(!pool.calls.some((c) => c.sql.includes('FROM pg_stat_statements\n')));
});

test('getStatements returns ready rows with a derived p95 and a safe ORDER BY', async () => {
  const pool = fakePool([
    ['pg_available_extensions', [{ installed: true, available: true }]],
    ['FROM pg_stat_statements', [
      { queryid: '1', query: 'SELECT 1', calls: '10', mean_exec_time: 100, stddev_exec_time: 20, max_exec_time: 500 },
    ]],
  ]);
  const result = await getStatements(pool, { sort: 'mean_exec_time', limit: 25 });
  assert.equal(result.status, 'ready');
  assert.equal(result.statements.length, 1);
  assert.ok(Math.abs(result.statements[0].p95_exec_time_est - 132.898) < 0.01);

  const listCall = pool.calls.find((c) => c.sql.includes('FROM pg_stat_statements'));
  // Sort key mapped to a real column; limit passed as a bound parameter.
  assert.match(listCall.sql, /ORDER BY mean_exec_time DESC/);
  assert.equal(listCall.params[0], 25);
});

test('getStatements maps a sort key off the allowlist to the default column', async () => {
  const pool = fakePool([
    ['pg_available_extensions', [{ installed: true, available: true }]],
    ['FROM pg_stat_statements', []],
  ]);
  await getStatements(pool, { sort: 'evil; DROP TABLE x' });
  const listCall = pool.calls.find((c) => c.sql.includes('FROM pg_stat_statements'));
  assert.match(listCall.sql, /ORDER BY total_exec_time DESC/);
});

test('getStatements distinguishes "created but not preloaded" from a real failure', async () => {
  const notLoaded = fakePool([
    ['pg_available_extensions', [{ installed: true, available: true }]],
    ['FROM pg_stat_statements', new Error('pg_stat_statements must be loaded via shared_preload_libraries')],
  ]);
  const result = await getStatements(notLoaded, {});
  assert.equal(result.status, 'not_loaded');
  assert.deepEqual(result.statements, []);

  // Any other error still propagates (the route turns it into a 500).
  const broken = fakePool([
    ['pg_available_extensions', [{ installed: true, available: true }]],
    ['FROM pg_stat_statements', new Error('out of memory')],
  ]);
  await assert.rejects(() => getStatements(broken, {}), /out of memory/);
});

test('enableStatements runs CREATE EXTENSION and returns refreshed status', async () => {
  const pool = fakePool([['pg_available_extensions', [{ installed: true, available: true }]]]);
  const result = await enableStatements(pool);
  assert.equal(result.enabled, true);
  // The DDL is run without a trailing semicolon (single statement).
  assert.match(pool.calls[0].sql, /^CREATE EXTENSION IF NOT EXISTS pg_stat_statements$/);
});

test('resetStatements calls pg_stat_statements_reset()', async () => {
  const pool = fakePool([['pg_stat_statements_reset', [{}]]]);
  assert.deepEqual(await resetStatements(pool), { reset: true });
  assert.match(pool.calls[0].sql, /pg_stat_statements_reset\(\)/);
});
