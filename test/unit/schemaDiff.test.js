/**
 * Unit tests for the schema diff & migration generator (roadmap §7.1).
 *
 * diffSchemas/buildMigration are pure, so they're tested against hand-built
 * snapshots — no live Postgres. The focus is the migration builder: it
 * interpolates identifiers (the injection-relevant bit, must be quoted), flags
 * destructive operations, and orders statements so dependencies hold. A small
 * fakePool test covers introspectSchema's row→snapshot mapping.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  introspectSchema,
  diffSchemas,
  buildMigration,
} = require('../../src/db/schemaDiff');

// --- snapshot helpers -------------------------------------------------------

function col(name, type, { notNull = false, def = null, ordinal = 1 } = {}) {
  return { name, ordinal, type, notNull, default: def };
}

function snap(schema, tables) {
  const out = { schema, tables: {} };
  for (const [name, t] of Object.entries(tables)) {
    out.tables[name] = {
      columns: t.columns ?? [],
      constraints: t.constraints ?? {},
      indexes: t.indexes ?? {},
    };
  }
  return out;
}

const sqlOf = (mig) => mig.statements.map((s) => s.sql);

// --- diffSchemas ------------------------------------------------------------

test('diffSchemas detects added, dropped, and changed tables', () => {
  const from = snap('public', {
    keep: { columns: [col('id', 'integer', { notNull: true })] },
    gone: { columns: [col('id', 'integer')] },
  });
  const to = snap('public', {
    keep: { columns: [col('id', 'integer', { notNull: true }), col('email', 'text')] },
    fresh: { columns: [col('id', 'integer')] },
  });
  const diff = diffSchemas(from, to);
  assert.deepEqual(diff.tables.added, ['fresh']);
  assert.deepEqual(diff.tables.dropped, ['gone']);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].table, 'keep');
  assert.deepEqual(diff.changed[0].columns.added.map((c) => c.name), ['email']);
});

test('diffSchemas flags column type/nullable/default changes, ignores identical', () => {
  const from = snap('public', {
    t: { columns: [col('a', 'integer'), col('b', 'text', { notNull: true })] },
  });
  // a: type change; b: identical → no change entry.
  const to = snap('public', {
    t: { columns: [col('a', 'bigint'), col('b', 'text', { notNull: true })] },
  });
  const diff = diffSchemas(from, to);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0].columns.changed.map((c) => c.name), ['a']);
});

test('diffSchemas returns no changed entry for identical schemas', () => {
  const s = snap('public', { t: { columns: [col('id', 'integer')] } });
  const diff = diffSchemas(s, structuredClone(s));
  assert.deepEqual(diff.tables.added, []);
  assert.deepEqual(diff.tables.dropped, []);
  assert.deepEqual(diff.changed, []);
});

// --- buildMigration: identifier escaping ------------------------------------

test('buildMigration quotes identifiers (no injection through table/column names)', () => {
  const from = snap('public', {});
  const to = snap('public', {
    'ev"il': { columns: [col('c"ol', 'text')] },
  });
  const sql = sqlOf(buildMigration(from, to))[0];
  assert.ok(sql.startsWith('CREATE TABLE "public"."ev""il"'), sql);
  assert.ok(sql.includes('"c""ol" text'), sql);
});

// --- buildMigration: statement kinds & destructive flags --------------------

test('buildMigration emits ADD COLUMN with NOT NULL and DEFAULT', () => {
  const from = snap('public', { t: { columns: [col('id', 'integer')] } });
  const to = snap('public', {
    t: { columns: [col('id', 'integer'), col('status', 'text', { notNull: true, def: "'new'::text" })] },
  });
  const sql = sqlOf(buildMigration(from, to));
  assert.ok(sql.some((s) =>
    s === 'ALTER TABLE "public"."t" ADD COLUMN "status" text NOT NULL DEFAULT \'new\'::text;'), sql);
});

test('buildMigration flags DROP COLUMN / DROP TABLE / type change as destructive', () => {
  const from = snap('public', {
    t: { columns: [col('id', 'integer'), col('old', 'text')] },
    gone: { columns: [col('id', 'integer')] },
  });
  const to = snap('public', {
    t: { columns: [col('id', 'bigint')] }, // id type change + old dropped
  });
  const mig = buildMigration(from, to);
  assert.equal(mig.hasDestructive, true);
  const destructive = mig.statements.filter((s) => s.destructive).map((s) => s.kind);
  assert.ok(destructive.includes('drop_column'));
  assert.ok(destructive.includes('drop_table'));
  assert.ok(destructive.includes('alter_column_type'));
});

test('buildMigration adds non-FK constraints before FK constraints', () => {
  const from = snap('public', { orders: { columns: [col('id', 'integer')] } });
  const to = snap('public', {
    orders: {
      columns: [col('id', 'integer')],
      constraints: {
        orders_pkey: { contype: 'p', definition: 'PRIMARY KEY (id)' },
        orders_cust_fk: { contype: 'f', definition: 'FOREIGN KEY (cust_id) REFERENCES customers(id)' },
      },
    },
  });
  const sql = sqlOf(buildMigration(from, to));
  const pkAt = sql.findIndex((s) => s.includes('PRIMARY KEY'));
  const fkAt = sql.findIndex((s) => s.includes('FOREIGN KEY'));
  assert.ok(pkAt >= 0 && fkAt >= 0 && pkAt < fkAt, sql.join('\n'));
});

test('buildMigration treats a changed index as drop + recreate', () => {
  const from = snap('public', {
    t: { columns: [col('a', 'text')], indexes: { t_a_idx: { definition: 'CREATE INDEX t_a_idx ON public.t USING btree (a)' } } },
  });
  const to = snap('public', {
    t: { columns: [col('a', 'text')], indexes: { t_a_idx: { definition: 'CREATE UNIQUE INDEX t_a_idx ON public.t USING btree (a)' } } },
  });
  const stmts = buildMigration(from, to).statements;
  const drop = stmts.find((s) => s.kind === 'drop_index');
  const create = stmts.find((s) => s.kind === 'create_index');
  assert.equal(drop.sql, 'DROP INDEX "public"."t_a_idx";');
  assert.ok(create.sql.endsWith(';')); // pg_get_indexdef has no trailing ;
  assert.ok(stmts.indexOf(drop) < stmts.indexOf(create));
});

test('buildMigration is reversible: backward = buildMigration(to, from)', () => {
  const a = snap('public', { t: { columns: [col('id', 'integer')] } });
  const b = snap('public', { t: { columns: [col('id', 'integer'), col('x', 'text')] } });
  // forward adds x; the reverse drops it.
  const fwd = sqlOf(buildMigration(a, b));
  const back = sqlOf(buildMigration(b, a));
  assert.ok(fwd.some((s) => s.includes('ADD COLUMN "x"')));
  assert.ok(back.some((s) => s === 'ALTER TABLE "public"."t" DROP COLUMN "x";'));
});

// --- introspectSchema (fakePool, mirrors indexAdvisor.test.js style) --------

function fakePool(matchers) {
  return {
    query: async (sql) => {
      for (const [needle, rows] of matchers) {
        if (sql.includes(needle)) return { rows, fields: [], rowCount: rows.length };
      }
      return { rows: [], fields: [], rowCount: 0 };
    },
  };
}

test('introspectSchema maps catalog rows into a normalized snapshot', async () => {
  const pool = fakePool([
    // 'c.relname AS table_name' (single space) is unique to TABLES_SQL; the
    // other queries pad that column out with many spaces before AS.
    ['c.relname AS table_name', [{ table_name: 'users' }]],
    ['format_type', [
      { table_name: 'users', column_name: 'id', ordinal: 1, data_type: 'integer', not_null: true, default_expr: "nextval('s')" },
      { table_name: 'users', column_name: 'email', ordinal: 2, data_type: 'text', not_null: false, default_expr: null },
    ]],
    ['pg_get_constraintdef', [
      { table_name: 'users', constraint_name: 'users_pkey', contype: 'p', definition: 'PRIMARY KEY (id)' },
    ]],
    ['pg_get_indexdef', [
      { table_name: 'users', index_name: 'users_email_idx', definition: 'CREATE INDEX users_email_idx ON public.users (email)' },
    ]],
  ]);
  const s = await introspectSchema(pool, 'public');
  assert.equal(s.schema, 'public');
  assert.equal(s.tables.users.columns.length, 2);
  assert.deepEqual(s.tables.users.columns[0], {
    name: 'id', ordinal: 1, type: 'integer', notNull: true, default: "nextval('s')",
  });
  assert.equal(s.tables.users.constraints.users_pkey.contype, 'p');
  assert.ok(s.tables.users.indexes.users_email_idx.definition.includes('email'));
});
