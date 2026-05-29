const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXPORT_FORMATS, FORMAT_META, createSerializer, csvField, sqlLiteral,
} = require('../../src/db/export');

// ---- csvField ---------------------------------------------------------------

test('csvField leaves plain values unquoted', () => {
  assert.equal(csvField('hello'), 'hello');
  assert.equal(csvField(42), '42');
  assert.equal(csvField(true), 'true');
});

test('csvField renders null/undefined as empty', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
});

test('csvField quotes and escapes delimiters, quotes, and newlines', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
});

test('csvField serializes objects/arrays as JSON', () => {
  // Object JSON contains `"`, so the field is CSV-quoted and quotes doubled.
  assert.equal(csvField({ a: 1 }), '"{""a"":1}"');
  // Array JSON contains `,`, so it too is CSV-quoted.
  assert.equal(csvField([1, 2]), '"[1,2]"');
});

test('csvField renders Date as ISO', () => {
  assert.equal(csvField(new Date('2020-01-02T03:04:05.000Z')), '2020-01-02T03:04:05.000Z');
});

// ---- sqlLiteral -------------------------------------------------------------

test('sqlLiteral handles nulls, numbers, booleans', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(7), '7');
  assert.equal(sqlLiteral(false), 'false');
});

test('sqlLiteral escapes single quotes in strings', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
});

test('sqlLiteral renders arrays as a Postgres array literal', () => {
  assert.equal(sqlLiteral(['a', 'b']), `'{"a","b"}'`);
  assert.equal(sqlLiteral([1, null, 3]), `'{1,NULL,3}'`);
});

test('sqlLiteral renders objects as quoted JSON with escaped quotes', () => {
  assert.equal(sqlLiteral({ k: "x'y" }), `'{"k":"x''y"}'`);
});

// ---- serializer: csv --------------------------------------------------------

test('csv serializer emits header then rows in column order', () => {
  const s = createSerializer('csv', { columns: ['id', 'name'], tableName: 't' });
  assert.equal(s.head(), 'id,name\r\n');
  assert.equal(s.row({ id: 1, name: 'Ann', extra: 'ignored' }), '1,Ann\r\n');
  assert.equal(s.row({ id: 2, name: 'a,b' }), '2,"a,b"\r\n');
  assert.equal(s.foot(), '');
});

// ---- serializer: json -------------------------------------------------------

test('json serializer brackets an array and commas between rows', () => {
  const s = createSerializer('json', { columns: ['id'], tableName: 't' });
  let out = s.head();
  out += s.row({ id: 1 });
  out += s.row({ id: 2 });
  out += s.foot();
  assert.deepEqual(JSON.parse(out), [{ id: 1 }, { id: 2 }]);
});

test('json serializer emits a valid empty array with no rows', () => {
  const s = createSerializer('json', { columns: ['id'], tableName: 't' });
  const out = s.head() + s.foot();
  assert.deepEqual(JSON.parse(out), []);
});

test('json serializer projects only the chosen columns', () => {
  const s = createSerializer('json', { columns: ['id'], tableName: 't' });
  const out = s.head() + s.row({ id: 1, secret: 'x' }) + s.foot();
  assert.deepEqual(JSON.parse(out), [{ id: 1 }]);
});

// ---- serializer: sql --------------------------------------------------------

test('sql serializer emits INSERT statements with quoted identifiers', () => {
  const s = createSerializer('sql', { columns: ['id', 'name'], tableName: 'users' });
  assert.match(s.head(), /-- pglens data export for "users"/);
  assert.equal(
    s.row({ id: 1, name: "O'Brien" }),
    `INSERT INTO "users" ("id", "name") VALUES (1, 'O''Brien');\n`,
  );
});

test('sql serializer quotes a table name containing a double quote', () => {
  const s = createSerializer('sql', { columns: ['a'], tableName: 'we"ird' });
  assert.equal(s.row({ a: 1 }), `INSERT INTO "we""ird" ("a") VALUES (1);\n`);
});

// ---- guards -----------------------------------------------------------------

test('unknown format throws', () => {
  assert.throws(() => createSerializer('xml', { columns: [], tableName: 't' }),
    /Unsupported export format/);
});

test('FORMAT_META covers every supported format', () => {
  for (const f of EXPORT_FORMATS) {
    assert.ok(FORMAT_META[f], `missing meta for ${f}`);
    assert.ok(FORMAT_META[f].extension);
    assert.ok(FORMAT_META[f].contentType);
  }
});
