const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrderBy, MAX_SORTS } = require('../../src/db/sort');

const cols = {
  id:      { dataType: 'integer', isPrimaryKey: true,  isForeignKey: false, foreignKeyRef: null, isUnique: true },
  name:    { dataType: 'text',    isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  created: { dataType: 'timestamp', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  status:  { dataType: 'text',    isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
};

test('buildOrderBy returns empty when spec is null and no PK', () => {
  assert.deepEqual(buildOrderBy(null, cols, null), { sql: '', columns: [] });
});

test('buildOrderBy emits PK tie-break when spec is empty and PK exists', () => {
  const { sql, columns } = buildOrderBy(null, cols, 'id');
  assert.equal(sql, ' ORDER BY "id" ASC');
  assert.deepEqual(columns, []);
});

test('single column sort with PK tie-break appended', () => {
  const { sql, columns } = buildOrderBy(
    [{ column: 'name', direction: 'asc' }], cols, 'id',
  );
  assert.equal(sql, ' ORDER BY "name" ASC, "id" ASC');
  assert.deepEqual(columns, ['name']);
});

test('PK already in user sort: not duplicated as tie-break', () => {
  const { sql } = buildOrderBy(
    [{ column: 'id', direction: 'desc' }], cols, 'id',
  );
  assert.equal(sql, ' ORDER BY "id" DESC');
});

test('multi-column sort preserves priority order', () => {
  const { sql, columns } = buildOrderBy([
    { column: 'status', direction: 'asc' },
    { column: 'created', direction: 'desc' },
    { column: 'name', direction: 'asc' },
  ], cols, 'id');
  assert.equal(sql, ' ORDER BY "status" ASC, "created" DESC, "name" ASC, "id" ASC');
  assert.deepEqual(columns, ['status', 'created', 'name']);
});

test('lowercase direction normalized to uppercase in SQL', () => {
  const { sql } = buildOrderBy(
    [{ column: 'name', direction: 'desc' }], cols, null,
  );
  assert.equal(sql, ' ORDER BY "name" DESC');
});

test('uppercase direction accepted', () => {
  const { sql } = buildOrderBy(
    [{ column: 'name', direction: 'ASC' }], cols, null,
  );
  assert.equal(sql, ' ORDER BY "name" ASC');
});

test('unknown column throws', () => {
  assert.throws(
    () => buildOrderBy([{ column: 'nope', direction: 'asc' }], cols),
    /Unknown sort column: nope/,
  );
});

test('invalid direction throws via schema', () => {
  assert.throws(
    () => buildOrderBy([{ column: 'name', direction: 'sideways' }], cols),
    /Invalid sort spec/,
  );
});

test('duplicate column entries deduped, first occurrence kept', () => {
  const { sql, columns } = buildOrderBy([
    { column: 'name', direction: 'asc' },
    { column: 'name', direction: 'desc' },
  ], cols, null);
  assert.equal(sql, ' ORDER BY "name" ASC');
  assert.deepEqual(columns, ['name']);
});

test('exceeding MAX_SORTS throws', () => {
  const entries = Array.from({ length: MAX_SORTS + 1 }, (_, i) => ({
    column: 'name', direction: 'asc',
  }));
  assert.throws(
    () => buildOrderBy(entries, cols),
    /Invalid sort spec/,
  );
});

test('null-byte column name rejected', () => {
  assert.throws(
    () => buildOrderBy([{ column: 'n\0ame', direction: 'asc' }], cols),
    /Invalid sort spec/,
  );
});

test('identifiers with embedded quotes are escaped', () => {
  const quoted = {
    'evil"name': { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  };
  const { sql } = buildOrderBy(
    [{ column: 'evil"name', direction: 'asc' }], quoted, null,
  );
  assert.equal(sql, ' ORDER BY "evil""name" ASC');
});
