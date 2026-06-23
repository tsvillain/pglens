const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each test needs its own HOME so saved-queries.json doesn't bleed between
// runs (the store caches in-process, and the on-disk file is keyed off HOME
// via src/config/paths.js).
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-saved-'));
  process.env.HOME = dir;
  return dir;
}

function freshStore() {
  delete require.cache[require.resolve('../../src/config/paths')];
  delete require.cache[require.resolve('../../src/db/savedQueries')];
  return require('../../src/db/savedQueries');
}

test('listSavedQueries returns empty when no file exists', () => {
  sandbox();
  const sq = freshStore();
  assert.deepEqual(sq.listSavedQueries(), []);
});

test('createSavedQuery assigns id + timestamps and persists', () => {
  const dir = sandbox();
  const sq = freshStore();
  const q = sq.createSavedQuery({
    connectionId: 'conn1',
    name: 'Recent orders',
    sql: 'SELECT * FROM orders WHERE created_at > {{since}}',
    folder: 'Reports/Daily',
    tags: ['orders', 'daily'],
    variables: { since: "'2026-01-01'" },
  });
  assert.match(q.id, /^[0-9a-f-]{36}$/);
  assert.ok(q.createdAt);
  assert.ok(q.updatedAt);
  assert.equal(q.folder, 'Reports/Daily');
  assert.deepEqual(q.tags, ['orders', 'daily']);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.pglens/saved-queries.json'), 'utf8'));
  assert.equal(raw.savedQueries.length, 1);
  assert.equal(raw.savedQueries[0].name, 'Recent orders');
});

test('createSavedQuery defaults optional fields', () => {
  sandbox();
  const sq = freshStore();
  const q = sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: 'SELECT 1' });
  assert.equal(q.description, null);
  assert.equal(q.folder, null);
  assert.deepEqual(q.tags, []);
  assert.equal(q.variables, null);
});

test('createSavedQuery blocks duplicate name within a connection', () => {
  sandbox();
  const sq = freshStore();
  sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: 'SELECT 1' });
  assert.throws(
    () => sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: 'SELECT 2' }),
    /already exists/,
  );
  // Same name, different connection — allowed.
  assert.doesNotThrow(() =>
    sq.createSavedQuery({ connectionId: 'other', name: 'A', sql: 'SELECT 3' }),
  );
});

test('listSavedQueries filters by connectionId', () => {
  sandbox();
  const sq = freshStore();
  sq.createSavedQuery({ connectionId: 'c1', name: 'a', sql: 'SELECT 1' });
  sq.createSavedQuery({ connectionId: 'c1', name: 'b', sql: 'SELECT 2' });
  sq.createSavedQuery({ connectionId: 'c2', name: 'c', sql: 'SELECT 3' });
  assert.equal(sq.listSavedQueries({ connectionId: 'c1' }).length, 2);
  assert.equal(sq.listSavedQueries({ connectionId: 'c2' }).length, 1);
  assert.equal(sq.listSavedQueries().length, 3);
});

test('updateSavedQuery rewrites disk and bumps updatedAt', async () => {
  sandbox();
  const sq = freshStore();
  const q = sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: 'SELECT 1' });
  await new Promise((r) => setTimeout(r, 10));
  const updated = sq.updateSavedQuery(q.id, { sql: 'SELECT 2', tags: ['x'] });
  assert.equal(updated.sql, 'SELECT 2');
  assert.deepEqual(updated.tags, ['x']);
  assert.notEqual(updated.updatedAt, q.updatedAt);
  assert.equal(updated.createdAt, q.createdAt);
});

test('updateSavedQuery blocks rename onto a sibling name', () => {
  sandbox();
  const sq = freshStore();
  sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: 'SELECT 1' });
  const b = sq.createSavedQuery({ connectionId: 'c', name: 'B', sql: 'SELECT 2' });
  assert.throws(() => sq.updateSavedQuery(b.id, { name: 'A' }), /already exists/);
});

test('updateSavedQuery returns null for unknown id', () => {
  sandbox();
  const sq = freshStore();
  assert.equal(
    sq.updateSavedQuery('00000000-0000-0000-0000-000000000000', { sql: 'SELECT 1' }),
    null,
  );
});

test('deleteSavedQuery removes from store and disk', () => {
  const dir = sandbox();
  const sq = freshStore();
  const q = sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: 'SELECT 1' });
  assert.equal(sq.deleteSavedQuery(q.id), true);
  assert.equal(sq.listSavedQueries().length, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.pglens/saved-queries.json'), 'utf8'));
  assert.equal(raw.savedQueries.length, 0);
});

test('importMany auto-suffixes names that collide within the connection', () => {
  sandbox();
  const sq = freshStore();
  sq.createSavedQuery({ connectionId: 'c', name: 'Report', sql: 'SELECT 1' });
  const created = sq.importMany('c', [
    { name: 'Report', sql: 'SELECT 2' },
    { name: 'Report', sql: 'SELECT 3' },
    { name: 'Fresh', sql: 'SELECT 4' },
  ]);
  assert.deepEqual(created.map((q) => q.name), ['Report (2)', 'Report (3)', 'Fresh']);
  assert.equal(sq.listSavedQueries({ connectionId: 'c' }).length, 4);
  // Imported records are bound to the target connection regardless of source.
  assert.ok(created.every((q) => q.connectionId === 'c'));
});

test('importMany rejects malformed items', () => {
  sandbox();
  const sq = freshStore();
  assert.throws(() => sq.importMany('c', [{ name: '', sql: 'SELECT 1' }]));
});

test('createSavedQuery rejects empty name and empty sql', () => {
  sandbox();
  const sq = freshStore();
  assert.throws(() => sq.createSavedQuery({ connectionId: 'c', name: '', sql: 'SELECT 1' }));
  assert.throws(() => sq.createSavedQuery({ connectionId: 'c', name: 'A', sql: '' }));
});

test('store survives a corrupt saved-queries.json (resets to empty)', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, '.pglens'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pglens/saved-queries.json'), '{ not json');
  const sq = freshStore();
  assert.deepEqual(sq.listSavedQueries(), []);
});
