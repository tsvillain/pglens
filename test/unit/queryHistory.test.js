const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-history-'));
  process.env.HOME = dir;
  return dir;
}

function freshStore() {
  delete require.cache[require.resolve('../../src/config/paths')];
  delete require.cache[require.resolve('../../src/db/queryHistory')];
  return require('../../src/db/queryHistory');
}

test('listHistory returns empty when no file exists', () => {
  sandbox();
  const h = freshStore();
  assert.deepEqual(h.listHistory({ connectionId: 'c' }), []);
});

test('addHistory assigns id + executedAt and persists', () => {
  const dir = sandbox();
  const h = freshStore();
  const entry = h.addHistory({
    connectionId: 'c',
    sql: 'SELECT 1',
    durationMs: 12,
    rowCount: 1,
    success: true,
  });
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.ok(entry.executedAt);
  assert.equal(entry.error, null);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.pglens/query-history.json'), 'utf8'));
  assert.equal(raw.entries.length, 1);
});

test('addHistory defaults nullable fields', () => {
  sandbox();
  const h = freshStore();
  const entry = h.addHistory({ connectionId: 'c', sql: 'SELECT 1', success: false, error: 'boom' });
  assert.equal(entry.durationMs, null);
  assert.equal(entry.rowCount, null);
  assert.equal(entry.success, false);
  assert.equal(entry.error, 'boom');
});

test('listHistory returns most-recent-first and filters by connection', () => {
  sandbox();
  const h = freshStore();
  h.addHistory({ connectionId: 'c1', sql: 'first', success: true });
  h.addHistory({ connectionId: 'c2', sql: 'other', success: true });
  h.addHistory({ connectionId: 'c1', sql: 'second', success: true });
  const c1 = h.listHistory({ connectionId: 'c1' });
  assert.deepEqual(c1.map((e) => e.sql), ['second', 'first']);
  assert.equal(h.listHistory({ connectionId: 'c2' }).length, 1);
});

test('listHistory honors limit', () => {
  sandbox();
  const h = freshStore();
  for (let i = 0; i < 5; i += 1) h.addHistory({ connectionId: 'c', sql: `q${i}`, success: true });
  const limited = h.listHistory({ connectionId: 'c', limit: 2 });
  assert.deepEqual(limited.map((e) => e.sql), ['q4', 'q3']);
});

test('addHistory enforces a per-connection ring buffer', () => {
  sandbox();
  const h = freshStore();
  const cap = h.MAX_PER_CONNECTION;
  for (let i = 0; i < cap + 10; i += 1) {
    h.addHistory({ connectionId: 'c', sql: `q${i}`, success: true });
  }
  // A second connection is unaffected by the first's trimming.
  h.addHistory({ connectionId: 'other', sql: 'keep', success: true });

  const list = h.listHistory({ connectionId: 'c' });
  assert.equal(list.length, cap);
  // Newest survives, the 10 oldest were dropped.
  assert.equal(list[0].sql, `q${cap + 9}`);
  assert.equal(list[list.length - 1].sql, 'q10');
  assert.equal(h.listHistory({ connectionId: 'other' }).length, 1);
});

test('deleteEntry removes a single entry', () => {
  sandbox();
  const h = freshStore();
  const e = h.addHistory({ connectionId: 'c', sql: 'SELECT 1', success: true });
  assert.equal(h.deleteEntry(e.id), true);
  assert.equal(h.listHistory({ connectionId: 'c' }).length, 0);
  assert.equal(h.deleteEntry('00000000-0000-0000-0000-000000000000'), false);
});

test('clearHistory removes only the target connection and returns the count', () => {
  sandbox();
  const h = freshStore();
  h.addHistory({ connectionId: 'c1', sql: 'a', success: true });
  h.addHistory({ connectionId: 'c1', sql: 'b', success: true });
  h.addHistory({ connectionId: 'c2', sql: 'c', success: true });
  assert.equal(h.clearHistory('c1'), 2);
  assert.equal(h.listHistory({ connectionId: 'c1' }).length, 0);
  assert.equal(h.listHistory({ connectionId: 'c2' }).length, 1);
  assert.equal(h.clearHistory('c1'), 0);
});

test('addHistory rejects empty sql and missing success', () => {
  sandbox();
  const h = freshStore();
  assert.throws(() => h.addHistory({ connectionId: 'c', sql: '', success: true }));
  assert.throws(() => h.addHistory({ connectionId: 'c', sql: 'SELECT 1' }));
});

test('store survives a corrupt query-history.json (resets to empty)', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, '.pglens'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pglens/query-history.json'), '{ not json');
  const h = freshStore();
  assert.deepEqual(h.listHistory({ connectionId: 'c' }), []);
});
