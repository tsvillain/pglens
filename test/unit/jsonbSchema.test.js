const { test } = require('node:test');
const assert = require('node:assert/strict');

const { inferFromValues } = require('../../src/db/jsonbSchema');

function byPath(paths) {
  return Object.fromEntries(paths.map((p) => [p.path, p]));
}

test('infers top-level keys with types and coverage', () => {
  const paths = byPath(inferFromValues([
    { id: 1, name: 'a' },
    { id: 2, name: 'b', active: true },
  ]));
  assert.deepEqual(paths.id.accessor, ['id']);
  assert.deepEqual(paths.id.types, ['number']);
  assert.equal(paths.id.frequency, 1);          // in both rows
  assert.equal(paths.active.occurrences, 1);    // only the second row
  assert.equal(paths.active.frequency, 0.5);
});

test('nested object keys produce a dotted path and a key-chain accessor', () => {
  const [p] = inferFromValues([{ addr: { city: 'NYC' } }]).filter((x) => x.path === 'addr.city');
  assert.deepEqual(p.accessor, ['addr', 'city']);
  assert.equal(p.sample, 'NYC');
});

test('mixed types at one path are merged and sorted', () => {
  const paths = byPath(inferFromValues([{ v: 1 }, { v: 'x' }, { v: null }]));
  assert.deepEqual(paths.v.types, ['null', 'number', 'string']);
});

test('array descent is marked unfilterable (null accessor) and gets [] display', () => {
  const paths = byPath(inferFromValues([{ tags: [{ name: 'x' }] }]));
  assert.equal(paths.tags.types[0], 'array');
  assert.deepEqual(paths.tags.accessor, ['tags']);  // the array itself is reachable
  assert.equal(paths['tags[].name'].accessor, null); // inside the array is not
});

test('empty sample yields no paths and no divide-by-zero', () => {
  assert.deepEqual(inferFromValues([]), []);
});
