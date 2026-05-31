const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAggregateSelect } = require('../../src/db/aggregate');

const columns = {
  id: { dataType: 'integer' },
  price: { dataType: 'numeric' },
  name: { dataType: 'text' },
  created_at: { dataType: 'timestamp with time zone' },
  active: { dataType: 'boolean' },
};

function selectOf(aggs) {
  return buildAggregateSelect(aggs, columns).selectSql;
}

test('null / empty spec yields nothing', () => {
  assert.equal(buildAggregateSelect(null, columns).selectSql, '');
  assert.equal(buildAggregateSelect([], columns).selectSql, '');
});

test('numeric functions on a numeric column', () => {
  assert.equal(
    selectOf([
      { column: 'price', fn: 'sum' },
      { column: 'price', fn: 'avg' },
    ]),
    'SUM("price") AS a0, AVG("price") AS a1',
  );
});

test('count distinct on text', () => {
  assert.equal(
    selectOf([{ column: 'name', fn: 'count_distinct' }]),
    'COUNT(DISTINCT "name") AS a0',
  );
});

test('boolean count_true / count_false use FILTER', () => {
  assert.equal(
    selectOf([
      { column: 'active', fn: 'count_true' },
      { column: 'active', fn: 'count_false' },
    ]),
    'COUNT(*) FILTER (WHERE "active" IS TRUE) AS a0, COUNT(*) FILTER (WHERE "active" IS FALSE) AS a1',
  );
});

test('unknown column rejected', () => {
  assert.throws(
    () => selectOf([{ column: 'nope', fn: 'count' }]),
    /Unknown column/,
  );
});

test('sum on a text column rejected', () => {
  assert.throws(
    () => selectOf([{ column: 'name', fn: 'sum' }]),
    /not valid on/,
  );
});

test('sum on a boolean column rejected', () => {
  assert.throws(
    () => selectOf([{ column: 'active', fn: 'sum' }]),
    /not valid on/,
  );
});

test('unknown function rejected', () => {
  assert.throws(
    () => selectOf([{ column: 'price', fn: 'median' }]),
    /unknown aggregate function/,
  );
});

test('identifiers with quotes are escaped', () => {
  const cols = { 'weird"col': { dataType: 'integer' } };
  assert.equal(
    buildAggregateSelect([{ column: 'weird"col', fn: 'max' }], cols).selectSql,
    'MAX("weird""col") AS a0',
  );
});
