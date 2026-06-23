const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWhere, MAX_DEPTH, MAX_CONDITIONS } = require('../../src/db/filter');

const cols = {
  id: { dataType: 'integer', isPrimaryKey: true, isForeignKey: false, foreignKeyRef: null, isUnique: true },
  name: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  status: { dataType: 'text', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  payload: { dataType: 'jsonb', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
  tags: { dataType: 'text[]', isPrimaryKey: false, isForeignKey: false, foreignKeyRef: null, isUnique: false },
};

test('buildWhere returns empty for null spec', () => {
  assert.deepEqual(buildWhere(null, cols), { sql: '', params: [] });
});

test('buildWhere returns empty for an empty group', () => {
  const { sql, params } = buildWhere(
    { type: 'group', combinator: 'and', children: [] }, cols,
  );
  assert.equal(sql, '');
  assert.deepEqual(params, []);
});

test('single equality emits parameterized = $1', () => {
  const { sql, params } = buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'status', op: 'eq', value: 'active' }],
  }, cols);
  assert.equal(sql, ' WHERE "status" = $1');
  assert.deepEqual(params, ['active']);
});

test('multi-condition AND wraps in parens with sequential params', () => {
  const { sql, params } = buildWhere({
    type: 'group', combinator: 'and',
    children: [
      { type: 'condition', column: 'status', op: 'eq', value: 'active' },
      { type: 'condition', column: 'id', op: 'gt', value: 100 },
    ],
  }, cols);
  assert.equal(sql, ' WHERE ("status" = $1 AND "id" > $2)');
  assert.deepEqual(params, ['active', 100]);
});

test('nested groups produce parenthesized OR/AND', () => {
  const { sql } = buildWhere({
    type: 'group', combinator: 'and',
    children: [
      { type: 'condition', column: 'status', op: 'eq', value: 'a' },
      {
        type: 'group', combinator: 'or',
        children: [
          { type: 'condition', column: 'id', op: 'lt', value: 10 },
          { type: 'condition', column: 'id', op: 'gt', value: 100 },
        ],
      },
    ],
  }, cols);
  assert.equal(sql, ' WHERE ("status" = $1 AND ("id" < $2 OR "id" > $3))');
});

test('IS NULL / IS NOT NULL have no params', () => {
  const { sql, params } = buildWhere({
    type: 'group', combinator: 'and',
    children: [
      { type: 'condition', column: 'name', op: 'is_null' },
      { type: 'condition', column: 'status', op: 'is_not_null' },
    ],
  }, cols);
  assert.equal(sql, ' WHERE ("name" IS NULL AND "status" IS NOT NULL)');
  assert.deepEqual(params, []);
});

test('IN / NIN use ANY/ALL with the array as one parameter', () => {
  const { sql, params } = buildWhere({
    type: 'group', combinator: 'and',
    children: [
      { type: 'condition', column: 'status', op: 'in', value: ['a', 'b'] },
      { type: 'condition', column: 'id', op: 'nin', value: [1, 2] },
    ],
  }, cols);
  assert.equal(sql, ' WHERE ("status" = ANY($1) AND "id" <> ALL($2))');
  assert.deepEqual(params, [['a', 'b'], [1, 2]]);
});

test('IN rejects empty array', () => {
  assert.throws(() => buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'status', op: 'in', value: [] }],
  }, cols), /non-empty array/);
});

test('LIKE / ILIKE require string values', () => {
  assert.throws(() => buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'name', op: 'like', value: 5 }],
  }, cols), /string value/);
});

test('jsonb_contains adds ::jsonb cast and stringifies object values', () => {
  const { sql, params } = buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'payload', op: 'jsonb_contains', value: { a: 1 } }],
  }, cols);
  assert.equal(sql, ' WHERE "payload" @> $1::jsonb');
  assert.deepEqual(params, ['{"a":1}']);
});

test('jsonb_contains rejects non-jsonb columns', () => {
  assert.throws(() => buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'name', op: 'jsonb_contains', value: { a: 1 } }],
  }, cols), /json\/jsonb/);
});

test('array_overlaps emits && with array param', () => {
  const { sql, params } = buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'tags', op: 'array_overlaps', value: ['x'] }],
  }, cols);
  assert.equal(sql, ' WHERE "tags" && $1');
  assert.deepEqual(params, [['x']]);
});

test('unknown column is rejected', () => {
  assert.throws(() => buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'nope', op: 'eq', value: 1 }],
  }, cols), /Unknown column/);
});

test('unknown operator is rejected at parse', () => {
  assert.throws(() => buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'id', op: 'between', value: 1 }],
  }, cols), /Invalid filter spec/);
});

test('column name with embedded double quote is properly escaped', () => {
  const oddCols = { 'we"ird': { dataType: 'text' } };
  const { sql } = buildWhere({
    type: 'group', combinator: 'and',
    children: [{ type: 'condition', column: 'we"ird', op: 'eq', value: 1 }],
  }, oddCols);
  assert.equal(sql, ' WHERE "we""ird" = $1');
});

test('depth limit is enforced', () => {
  let node = { type: 'condition', column: 'id', op: 'eq', value: 1 };
  for (let i = 0; i <= MAX_DEPTH + 1; i++) {
    node = { type: 'group', combinator: 'and', children: [node] };
  }
  assert.throws(() => buildWhere(node, cols), /max depth/);
});

test('condition-count limit is enforced', () => {
  const children = [];
  for (let i = 0; i < MAX_CONDITIONS + 1; i++) {
    children.push({ type: 'condition', column: 'id', op: 'eq', value: i });
  }
  assert.throws(
    () => buildWhere({ type: 'group', combinator: 'and', children }, cols),
    /max of/,
  );
});
