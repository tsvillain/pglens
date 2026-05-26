const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUpdateRow } = require('../../src/db/update');

const cols = {
  id: { dataType: 'integer', isPrimaryKey: true, isForeignKey: false, foreignKeyRef: null, isUnique: true, isNullable: false },
  name: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: true },
  status: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: true },
  payload: { dataType: 'jsonb', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: true },
};

const compositeCols = {
  tenant_id: { dataType: 'uuid', isPrimaryKey: true, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: false },
  id: { dataType: 'integer', isPrimaryKey: true, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: false },
  name: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false, isNullable: true },
};

test('builds a parameterized UPDATE with single-column PK', () => {
  const { sql, params } = buildUpdateRow(
    { where: { id: 7 }, set: { name: 'bob', status: 'active' } },
    cols,
    '"public"."users"',
  );
  assert.equal(
    sql,
    'UPDATE "public"."users" SET "name" = $1, "status" = $2 WHERE "id" = $3 RETURNING *',
  );
  assert.deepEqual(params, ['bob', 'active', 7]);
});

test('jsonb objects are stringified and cast to ::jsonb', () => {
  const { sql, params } = buildUpdateRow(
    { where: { id: 1 }, set: { payload: { a: 1 } } },
    cols,
    '"public"."t"',
  );
  assert.equal(sql, 'UPDATE "public"."t" SET "payload" = $1::jsonb WHERE "id" = $2 RETURNING *');
  assert.deepEqual(params, ['{"a":1}', 1]);
});

test('jsonb null does NOT get the cast (so the column is set to SQL NULL)', () => {
  const { sql, params } = buildUpdateRow(
    { where: { id: 1 }, set: { payload: null } },
    cols,
    '"public"."t"',
  );
  assert.equal(sql, 'UPDATE "public"."t" SET "payload" = $1 WHERE "id" = $2 RETURNING *');
  assert.deepEqual(params, [null, 1]);
});

test('composite PK requires every key in where', () => {
  assert.throws(
    () =>
      buildUpdateRow(
        { where: { id: 5 }, set: { name: 'x' } },
        compositeCols,
        '"public"."t"',
      ),
    /every primary-key column/,
  );
});

test('non-PK key in where is rejected', () => {
  assert.throws(
    () =>
      buildUpdateRow(
        { where: { id: 1, name: 'x' }, set: { status: 'y' } },
        cols,
        '"public"."t"',
      ),
    /only accepts primary-key columns/,
  );
});

test('unknown column in set is rejected', () => {
  assert.throws(
    () =>
      buildUpdateRow(
        { where: { id: 1 }, set: { nope: 1 } },
        cols,
        '"public"."t"',
      ),
    /Unknown column/,
  );
});

test('empty set is rejected', () => {
  assert.throws(
    () =>
      buildUpdateRow({ where: { id: 1 }, set: {} }, cols, '"public"."t"'),
    /at least one column/,
  );
});

test('table with no PK is rejected', () => {
  const noPk = { ...cols };
  noPk.id = { ...cols.id, isPrimaryKey: false };
  assert.throws(
    () =>
      buildUpdateRow({ where: { id: 1 }, set: { name: 'x' } }, noPk, '"public"."t"'),
    /no primary key/,
  );
});

test('composite PK happy path emits both keys in WHERE', () => {
  const { sql, params } = buildUpdateRow(
    {
      where: { id: 5, tenant_id: '11111111-1111-1111-1111-111111111111' },
      set: { name: 'x' },
    },
    compositeCols,
    '"public"."t"',
  );
  assert.equal(
    sql,
    'UPDATE "public"."t" SET "name" = $1 WHERE "tenant_id" = $2 AND "id" = $3 RETURNING *',
  );
  assert.deepEqual(params, ['x', '11111111-1111-1111-1111-111111111111', 5]);
});

test('quoted identifiers handle special characters', () => {
  const fancy = {
    'Id"With"Quotes': { dataType: 'integer', isPrimaryKey: true, isNullable: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
    'col with spaces': { dataType: 'text', isPrimaryKey: false, isNullable: true, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  };
  const { sql } = buildUpdateRow(
    { where: { 'Id"With"Quotes': 1 }, set: { 'col with spaces': 'v' } },
    fancy,
    '"s"."t"',
  );
  assert.equal(
    sql,
    'UPDATE "s"."t" SET "col with spaces" = $1 WHERE "Id""With""Quotes" = $2 RETURNING *',
  );
});
