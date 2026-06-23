const test = require('node:test');
const assert = require('node:assert/strict');

const { buildInsertRow } = require('../../src/db/insert');

const cols = {
  id: { dataType: 'integer', isPrimaryKey: true, isForeignKey: false, foreignKeyRef: null, isUnique: true, isNullable: false, hasDefault: true },
  name: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: true, hasDefault: false },
  status: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: false, hasDefault: true },
  payload: { dataType: 'jsonb', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: true, hasDefault: false },
};

test('builds a parameterized INSERT with the supplied columns', () => {
  const { sql, params } = buildInsertRow(
    { values: { name: 'bob', status: 'active' } },
    cols,
    '"public"."users"',
  );
  assert.equal(
    sql,
    'INSERT INTO "public"."users" ("name", "status") VALUES ($1, $2) RETURNING *',
  );
  assert.deepEqual(params, ['bob', 'active']);
});

test('omitted columns are simply absent so the DB applies their DEFAULT', () => {
  const { sql, params } = buildInsertRow(
    { values: { name: 'bob' } },
    cols,
    '"public"."users"',
  );
  // `id` and `status` (both default-having) are not in the column list.
  assert.equal(sql, 'INSERT INTO "public"."users" ("name") VALUES ($1) RETURNING *');
  assert.deepEqual(params, ['bob']);
});

test('empty values emit DEFAULT VALUES', () => {
  const { sql, params } = buildInsertRow({ values: {} }, cols, '"public"."t"');
  assert.equal(sql, 'INSERT INTO "public"."t" DEFAULT VALUES RETURNING *');
  assert.deepEqual(params, []);
});

test('jsonb objects are stringified and cast to ::jsonb', () => {
  const { sql, params } = buildInsertRow(
    { values: { payload: { a: 1 } } },
    cols,
    '"public"."t"',
  );
  assert.equal(sql, 'INSERT INTO "public"."t" ("payload") VALUES ($1::jsonb) RETURNING *');
  assert.deepEqual(params, ['{"a":1}']);
});

test('jsonb null does NOT get the cast (so the column is set to SQL NULL)', () => {
  const { sql, params } = buildInsertRow(
    { values: { payload: null } },
    cols,
    '"public"."t"',
  );
  assert.equal(sql, 'INSERT INTO "public"."t" ("payload") VALUES ($1) RETURNING *');
  assert.deepEqual(params, [null]);
});

test('explicit NULL is preserved for a regular column', () => {
  const { sql, params } = buildInsertRow(
    { values: { name: null } },
    cols,
    '"public"."t"',
  );
  assert.equal(sql, 'INSERT INTO "public"."t" ("name") VALUES ($1) RETURNING *');
  assert.deepEqual(params, [null]);
});

test('unknown column is rejected', () => {
  assert.throws(
    () => buildInsertRow({ values: { nope: 1 } }, cols, '"public"."t"'),
    /Unknown column/,
  );
});

test('non-object values is rejected', () => {
  assert.throws(
    () => buildInsertRow({ values: [1, 2] }, cols, '"public"."t"'),
    /`values` must be an object/,
  );
  assert.throws(
    () => buildInsertRow({}, cols, '"public"."t"'),
    /`values` must be an object/,
  );
});

test('quoted identifiers handle special characters', () => {
  const fancy = {
    'col with spaces': { dataType: 'text', isPrimaryKey: false, isNullable: true, isForeignKey: false, foreignKeyRef: null, isUnique: false, hasDefault: false },
    'Weird"Col': { dataType: 'integer', isPrimaryKey: false, isNullable: true, isForeignKey: false, foreignKeyRef: null, isUnique: false, hasDefault: false },
  };
  const { sql } = buildInsertRow(
    { values: { 'col with spaces': 'v', 'Weird"Col': 3 } },
    fancy,
    '"s"."t"',
  );
  assert.equal(
    sql,
    'INSERT INTO "s"."t" ("col with spaces", "Weird""Col") VALUES ($1, $2) RETURNING *',
  );
});

test('multiple jsonb/regular params get sequential placeholders', () => {
  const { sql, params } = buildInsertRow(
    { values: { name: 'x', payload: { k: 'v' }, status: 'on' } },
    cols,
    '"public"."t"',
  );
  assert.equal(
    sql,
    'INSERT INTO "public"."t" ("name", "payload", "status") VALUES ($1, $2::jsonb, $3) RETURNING *',
  );
  assert.deepEqual(params, ['x', '{"k":"v"}', 'on']);
});
