/**
 * Unit tests for the index assistant (roadmap §6.4).
 *
 * A fake pool returns canned catalog rows by matching a substring of the SQL,
 * so we can assert the DROP-DDL generation (the one security-relevant pure bit,
 * since it interpolates identifiers) and getAdvice()'s "one bad section
 * degrades, the rest survive" contract — without a live Postgres.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getAdvice,
  getUnusedIndexes,
  getDuplicateIndexes,
  buildDropIndexDdl,
} = require('../../src/db/indexAdvisor');

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

test('buildDropIndexDdl quotes and escapes both identifiers', () => {
  assert.equal(buildDropIndexDdl('public', 'idx_foo'), 'DROP INDEX "public"."idx_foo";');
  // Embedded double quotes are doubled — no SQL injection through an index name.
  assert.equal(
    buildDropIndexDdl('public', 'evil"; DROP TABLE users; --'),
    'DROP INDEX "public"."evil""; DROP TABLE users; --";',
  );
});

test('getUnusedIndexes attaches DROP DDL and passes the schema', async () => {
  const pool = fakePool([
    ['pg_stat_user_indexes', [
      { table_name: 'orders', index_name: 'idx_old', idx_scan: '0',
        size_bytes: 1024, size_pretty: '1 kB', indexdef: 'CREATE INDEX ...' },
    ]],
  ]);
  const rows = await getUnusedIndexes(pool, 'shop');
  assert.equal(pool.calls[0].params[0], 'shop');
  assert.equal(rows[0].drop_ddl, 'DROP INDEX "shop"."idx_old";');
});

test('getDuplicateIndexes attaches per-index DROP DDL within each group', async () => {
  const pool = fakePool([
    ['HAVING count(*) > 1', [
      { table_name: 'orders', indexes: [
        { index_name: 'idx_a', indexdef: 'CREATE INDEX ...', size_bytes: 2048, size_pretty: '2 kB', idx_scan: '5' },
        { index_name: 'idx_b', indexdef: 'CREATE INDEX ...', size_bytes: 2048, size_pretty: '2 kB', idx_scan: '0' },
      ] },
    ]],
  ]);
  const groups = await getDuplicateIndexes(pool, 'public');
  assert.equal(groups[0].indexes[0].drop_ddl, 'DROP INDEX "public"."idx_a";');
  assert.equal(groups[0].indexes[1].drop_ddl, 'DROP INDEX "public"."idx_b";');
});

test('getAdvice isolates a failing section', async () => {
  const pool = fakePool([
    // `idx_scan = 0` is unique to the unused-index query — the duplicate query
    // also mentions pg_stat_user_indexes (a LEFT JOIN), so match on the filter.
    ['idx_scan = 0', new Error('permission denied for pg_stat_user_indexes')],
    ['HAVING count(*) > 1', [{ table_name: 't', indexes: [] }]],
    ['pg_stat_user_tables', [{ table_name: 'big', seq_scan: '99' }]],
  ]);
  const advice = await getAdvice(pool, 'public');

  assert.equal(advice.unused.data, null);
  assert.match(advice.unused.error, /permission denied/);

  assert.equal(advice.duplicate.error, null);
  assert.ok(Array.isArray(advice.duplicate.data));
  assert.equal(advice.seqScans.error, null);
  assert.equal(advice.seqScans.data[0].table_name, 'big');
});
