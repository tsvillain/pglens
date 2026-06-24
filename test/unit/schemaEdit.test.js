const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEditDDL, validateType, validateDefault } = require('../../src/db/schemaEdit');

test('add_column escapes table + column and renders the type', () => {
  const { statements } = buildEditDDL('public', [
    { op: 'add_column', table: 'users', column: { name: 'age', type: 'integer' } },
  ]);
  assert.equal(statements[0].sql, 'ALTER TABLE "public"."users" ADD COLUMN "age" integer;');
  assert.equal(statements[0].destructive, false);
});

test('add_column with NOT NULL + DEFAULT', () => {
  const { statements } = buildEditDDL('public', [
    { op: 'add_column', table: 't', column: { name: 'created', type: 'timestamptz', notNull: true, default: 'now()' } },
  ]);
  assert.equal(statements[0].sql, 'ALTER TABLE "public"."t" ADD COLUMN "created" timestamptz NOT NULL DEFAULT now();');
});

test('alter_column rename then retype uses the new name', () => {
  const { statements, hasDestructive } = buildEditDDL('public', [
    { op: 'alter_column', table: 't', name: 'old', rename: 'new', type: 'bigint' },
  ]);
  assert.deepEqual(statements.map((s) => s.sql), [
    'ALTER TABLE "public"."t" RENAME COLUMN "old" TO "new";',
    'ALTER TABLE "public"."t" ALTER COLUMN "new" TYPE bigint;',
  ]);
  assert.equal(hasDestructive, true); // type change is destructive
});

test('alter_column default: null drops, string sets', () => {
  const drop = buildEditDDL('public', [{ op: 'alter_column', table: 't', name: 'c', default: null }]);
  assert.match(drop.statements[0].sql, /DROP DEFAULT;$/);
  const set = buildEditDDL('public', [{ op: 'alter_column', table: 't', name: 'c', default: '0' }]);
  assert.match(set.statements[0].sql, /SET DEFAULT 0;$/);
});

test('drop_column is flagged destructive', () => {
  const { statements } = buildEditDDL('public', [{ op: 'drop_column', table: 't', name: 'c' }]);
  assert.equal(statements[0].sql, 'ALTER TABLE "public"."t" DROP COLUMN "c";');
  assert.equal(statements[0].destructive, true);
});

test('add_foreign_key builds a named FK constraint', () => {
  const { statements } = buildEditDDL('public', [
    { op: 'add_foreign_key', table: 'orders', column: 'user_id', refTable: 'users', refColumn: 'id' },
  ]);
  assert.equal(
    statements[0].sql,
    'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id");',
  );
});

test('drop_foreign_key drops the named constraint and is destructive', () => {
  const { statements } = buildEditDDL('public', [
    { op: 'drop_foreign_key', table: 'orders', name: 'fk_orders_user_id' },
  ]);
  assert.equal(statements[0].sql, 'ALTER TABLE "public"."orders" DROP CONSTRAINT "fk_orders_user_id";');
  assert.equal(statements[0].destructive, true);
});

test('type validation blocks statement injection', () => {
  assert.throws(() => validateType('integer; DROP TABLE users'), /Invalid column type/);
  assert.throws(() => validateType('text)--'), /Invalid column type/);
  assert.equal(validateType('numeric(10,2)'), 'numeric(10,2)');
  assert.equal(validateType('text[]'), 'text[]');
});

test('default validation blocks semicolons / null bytes', () => {
  assert.throws(() => validateDefault("1; DROP TABLE users"), /Invalid default/);
  assert.throws(() => validateDefault('a\0b'), /Invalid default/);
  assert.equal(validateDefault('now()'), 'now()');
  assert.equal(validateDefault("'active'"), "'active'");
});

test('an injection-laden identifier is neutralised by quoting, not executed', () => {
  const { statements } = buildEditDDL('public', [
    { op: 'drop_column', table: 'users"; DROP TABLE users; --', name: 'x' },
  ]);
  assert.match(statements[0].sql, /"users""; DROP TABLE users; --"/);
});
