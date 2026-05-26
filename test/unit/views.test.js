const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each test needs its own HOME so the views.json file doesn't bleed between
// runs (the store caches in-process, and the on-disk file is keyed off HOME
// via src/config/paths.js).
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglens-views-'));
  process.env.HOME = dir;
  return dir;
}

function freshStore() {
  // Re-require both modules so the new HOME drives VIEWS_FILE and the
  // in-memory cache is empty.
  delete require.cache[require.resolve('../../src/config/paths')];
  delete require.cache[require.resolve('../../src/db/views')];
  return require('../../src/db/views');
}

test('listViews returns empty when no file exists', () => {
  sandbox();
  const views = freshStore();
  assert.deepEqual(views.listViews(), []);
});

test('createView assigns id + timestamps and persists', () => {
  const dir = sandbox();
  const views = freshStore();
  const v = views.createView({
    connectionId: 'conn1',
    tableName: 'orders',
    name: 'Open orders',
    filter: {
      type: 'group',
      combinator: 'and',
      children: [{ type: 'condition', column: 'status', op: 'eq', value: 'open' }],
    },
    sort: [{ column: 'created_at', direction: 'desc' }],
  });
  assert.match(v.id, /^[0-9a-f-]{36}$/);
  assert.ok(v.createdAt);
  assert.ok(v.updatedAt);

  // Persisted to disk.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.pglens/views.json'), 'utf8'));
  assert.equal(raw.views.length, 1);
  assert.equal(raw.views[0].name, 'Open orders');
});

test('createView blocks duplicate name within (connection, table)', () => {
  sandbox();
  const views = freshStore();
  views.createView({ connectionId: 'c', tableName: 't', name: 'A' });
  assert.throws(
    () => views.createView({ connectionId: 'c', tableName: 't', name: 'A' }),
    /already exists/,
  );
  // Same name, different table — allowed.
  assert.doesNotThrow(() =>
    views.createView({ connectionId: 'c', tableName: 'other', name: 'A' }),
  );
});

test('listViews filters by connectionId + tableName', () => {
  sandbox();
  const views = freshStore();
  views.createView({ connectionId: 'c1', tableName: 't1', name: 'a' });
  views.createView({ connectionId: 'c1', tableName: 't2', name: 'b' });
  views.createView({ connectionId: 'c2', tableName: 't1', name: 'c' });
  assert.equal(views.listViews({ connectionId: 'c1' }).length, 2);
  assert.equal(views.listViews({ connectionId: 'c1', tableName: 't1' }).length, 1);
  assert.equal(views.listViews({}).length, 3);
});

test('updateView rewrites the on-disk file and bumps updatedAt', async () => {
  sandbox();
  const views = freshStore();
  const v = views.createView({ connectionId: 'c', tableName: 't', name: 'A' });
  // Ensure the timestamp resolution flips.
  await new Promise((r) => setTimeout(r, 10));
  const updated = views.updateView(v.id, { name: 'A2' });
  assert.equal(updated.name, 'A2');
  assert.notEqual(updated.updatedAt, v.updatedAt);
  assert.equal(updated.createdAt, v.createdAt);
});

test('updateView blocks rename onto a sibling name', () => {
  sandbox();
  const views = freshStore();
  views.createView({ connectionId: 'c', tableName: 't', name: 'A' });
  const b = views.createView({ connectionId: 'c', tableName: 't', name: 'B' });
  assert.throws(() => views.updateView(b.id, { name: 'A' }), /already exists/);
});

test('updateView returns null for unknown id', () => {
  sandbox();
  const views = freshStore();
  assert.equal(
    views.updateView('00000000-0000-0000-0000-000000000000', { name: 'x' }),
    null,
  );
});

test('deleteView removes from store and disk', () => {
  const dir = sandbox();
  const views = freshStore();
  const v = views.createView({ connectionId: 'c', tableName: 't', name: 'A' });
  assert.equal(views.deleteView(v.id), true);
  assert.equal(views.listViews().length, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.pglens/views.json'), 'utf8'));
  assert.equal(raw.views.length, 0);
});

test('deleteView returns false for unknown id', () => {
  sandbox();
  const views = freshStore();
  assert.equal(
    views.deleteView('00000000-0000-0000-0000-000000000000'),
    false,
  );
});

test('createView rejects empty name', () => {
  sandbox();
  const views = freshStore();
  assert.throws(() =>
    views.createView({ connectionId: 'c', tableName: 't', name: '' }),
  );
});

test('createView rejects malformed filter', () => {
  sandbox();
  const views = freshStore();
  assert.throws(() =>
    views.createView({
      connectionId: 'c',
      tableName: 't',
      name: 'bad',
      filter: { type: 'group', combinator: 'xor', children: [] },
    }),
  );
});

test('store survives a corrupt views.json (resets to empty)', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, '.pglens'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pglens/views.json'), '{ not json');
  const views = freshStore();
  assert.deepEqual(views.listViews(), []);
});
