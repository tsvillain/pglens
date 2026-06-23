const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IMPORT_MODES, buildImportStatement, batchSizeFor, coerceCell, columnCast,
} = require('../../src/db/import');

const META = {
  id: { dataType: 'integer' },
  name: { dataType: 'text' },
  payload: { dataType: 'jsonb' },
};
const TABLE = '"public"."users"';

function build(opts) {
  return buildImportStatement({
    qualifiedTable: TABLE,
    targetColumns: ['id', 'name'],
    columnMeta: META,
    rows: [['1', 'Ann'], ['2', 'Bob']],
    mode: 'insert',
    ...opts,
  });
}

// ---- coerceCell -------------------------------------------------------------

test('coerceCell maps null/undefined to null', () => {
  assert.equal(coerceCell(null, true), null);
  assert.equal(coerceCell(undefined, true), null);
});

test('coerceCell maps empty string to null only when emptyAsNull', () => {
  assert.equal(coerceCell('', true), null);
  assert.equal(coerceCell('', false), '');
});

test('coerceCell passes other values through unchanged', () => {
  assert.equal(coerceCell('42', true), '42');
  assert.equal(coerceCell('hello', false), 'hello');
});

// ---- columnCast -------------------------------------------------------------

test('columnCast casts only json/jsonb', () => {
  assert.equal(columnCast({ dataType: 'jsonb' }), '::jsonb');
  assert.equal(columnCast({ dataType: 'json' }), '::json');
  assert.equal(columnCast({ dataType: 'integer' }), '');
  assert.equal(columnCast(undefined), '');
});

// ---- buildImportStatement: shape -------------------------------------------

test('builds a parameterized multi-row INSERT in column order', () => {
  const { sql, params } = build();
  assert.equal(
    sql,
    'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2), ($3, $4)' +
    ' RETURNING (xmax = 0) AS pglens_inserted',
  );
  assert.deepEqual(params, ['1', 'Ann', '2', 'Bob']);
});

test('applies a jsonb cast on the placeholder for json columns', () => {
  const { sql, params } = buildImportStatement({
    qualifiedTable: TABLE,
    targetColumns: ['id', 'payload'],
    columnMeta: META,
    rows: [['1', '{"a":1}']],
    mode: 'insert',
  });
  assert.match(sql, /VALUES \(\$1, \$2::jsonb\)/);
  assert.deepEqual(params, ['1', '{"a":1}']);
});

test('blank cells bind as NULL by default and as "" when emptyAsNull is false', () => {
  assert.deepEqual(build({ rows: [['', 'x']] }).params, [null, 'x']);
  assert.deepEqual(build({ rows: [['', 'x']], emptyAsNull: false }).params, ['', 'x']);
});

// ---- conflict modes ---------------------------------------------------------

test('skip mode appends ON CONFLICT DO NOTHING', () => {
  assert.match(build({ mode: 'skip' }).sql, /ON CONFLICT DO NOTHING RETURNING/);
});

test('update mode upserts non-key columns via EXCLUDED', () => {
  const { sql } = build({ mode: 'update', conflictColumns: ['id'] });
  assert.match(sql, /ON CONFLICT \("id"\) DO UPDATE SET "name" = EXCLUDED\."name"/);
});

test('update mode with only key columns degrades to DO NOTHING', () => {
  const { sql } = buildImportStatement({
    qualifiedTable: TABLE,
    targetColumns: ['id'],
    columnMeta: META,
    rows: [['1']],
    mode: 'update',
    conflictColumns: ['id'],
  });
  assert.match(sql, /ON CONFLICT \("id"\) DO NOTHING/);
});

// ---- guards -----------------------------------------------------------------

test('unknown mode throws', () => {
  assert.throws(() => build({ mode: 'merge' }), /Unknown import mode/);
});

test('unknown target column throws', () => {
  assert.throws(() => build({ targetColumns: ['id', 'ghost'] }), /Unknown column: ghost/);
});

test('duplicate target column throws', () => {
  assert.throws(() => build({ targetColumns: ['id', 'id'] }), /Duplicate target column/);
});

test('a ragged row throws', () => {
  assert.throws(() => build({ rows: [['1']] }), /expected 2/);
});

test('update mode without conflict columns throws', () => {
  assert.throws(() => build({ mode: 'update' }), /requires at least one conflict column/);
});

test('a conflict column outside the mapping throws', () => {
  assert.throws(
    () => build({ mode: 'update', conflictColumns: ['name', 'missing'] }),
    /must be one of the mapped columns/,
  );
});

test('empty rows throws', () => {
  assert.throws(() => build({ rows: [] }), /No rows to import/);
});

// ---- batchSizeFor -----------------------------------------------------------

test('batchSizeFor keeps rows*columns under the 65535 param cap', () => {
  assert.equal(batchSizeFor(1), 65535);
  assert.equal(batchSizeFor(10), 6553);
  assert.ok(batchSizeFor(10) * 10 <= 65535);
  assert.equal(batchSizeFor(0), 1);
});

test('IMPORT_MODES lists the three wizard modes', () => {
  assert.deepEqual(IMPORT_MODES, ['insert', 'skip', 'update']);
});
