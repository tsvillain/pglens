/**
 * Schema diff & migration generator (roadmap §7.1).
 *
 * Introspect two schemas into normalized snapshots, diff them, and generate an
 * idempotent-ish migration that transforms one into the other (plus its
 * reverse). Like the index assistant, nothing here ever runs the migration: the
 * generated SQL is handed to the user to review and run in the editor, so every
 * destructive operation stays behind the editor's Run button.
 *
 * Three pieces:
 *   - introspectSchema(pool, schema)  — the only DB-touching part. Reads tables,
 *     columns, constraints, and (non-constraint) indexes from the catalogs,
 *     letting Postgres render constraint/index DDL via pg_get_*def().
 *   - diffSchemas(from, to)           — pure. Structured diff for the viewer.
 *   - buildMigration(from, to)        — pure. Ordered statement list (with a
 *     `destructive` flag per statement) to turn `from` into `to`. The reverse
 *     migration is just buildMigration(to, from) — same code, args swapped.
 *
 * ponytail: the .sql-baseline-file side of the roadmap (diff a live DB against a
 * dump) is skipped — it needs a real DDL parser to build a snapshot from text.
 * Both sides here are live connections (prod-vs-staging, the common case). Add
 * the file baseline when a parser is on hand. The migration also assumes both
 * sides use the same schema *name* (so pg_get_*def() output lines up); cross-
 * schema renames are out of scope — note it in the header comment, don't parse.
 */

const { quoteIdent, quoteQualifiedIdent } = require('./identifier');

// --- Introspection (the only part that touches the database) ----------------

const TABLES_SQL = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'p')
   ORDER BY c.relname`;

// format_type() gives the faithful type (e.g. numeric(10,2), varchar(255),
// int4[]) — more accurate than information_schema for diffing.
const COLUMNS_SQL = `
  SELECT c.relname                              AS table_name,
         a.attname                              AS column_name,
         a.attnum                               AS ordinal,
         format_type(a.atttypid, a.atttypmod)   AS data_type,
         a.attnotnull                           AS not_null,
         pg_get_expr(d.adbin, d.adrelid)        AS default_expr
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'p')
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum`;

// All constraints, with Postgres-rendered DDL. contype: p=PK f=FK u=unique
// c=check x=exclusion. FKs are emitted last in the migration (see ordering).
const CONSTRAINTS_SQL = `
  SELECT c.relname                     AS table_name,
         con.conname                   AS constraint_name,
         con.contype::text             AS contype,
         pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = con.connamespace
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'p')
   ORDER BY c.relname, con.conname`;

// Only indexes NOT backing a constraint — PK/unique indexes are handled through
// the constraint section, so excluding them here avoids emitting both.
const INDEXES_SQL = `
  SELECT c.relname                      AS table_name,
         ic.relname                     AS index_name,
         pg_get_indexdef(i.indexrelid)  AS definition
    FROM pg_index i
    JOIN pg_class ic    ON ic.oid = i.indexrelid
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
   ORDER BY c.relname, ic.relname`;

/**
 * Read one schema into a normalized snapshot:
 *   { schema, tables: { [name]: { columns: [...ordered], constraints: {}, indexes: {} } } }
 * Columns stay an ordered array (for CREATE TABLE); constraints/indexes are
 * keyed by name (for by-name diffing).
 */
async function introspectSchema(pool, schema) {
  const [tables, columns, constraints, indexes] = await Promise.all([
    pool.query(TABLES_SQL, [schema]),
    pool.query(COLUMNS_SQL, [schema]),
    pool.query(CONSTRAINTS_SQL, [schema]),
    pool.query(INDEXES_SQL, [schema]),
  ]);

  const snapshot = { schema, tables: {} };
  const table = (name) =>
    (snapshot.tables[name] ??= { columns: [], constraints: {}, indexes: {} });

  for (const r of tables.rows) table(r.table_name);
  for (const r of columns.rows) {
    // A column on a table not seen in TABLES_SQL can't happen, but guard anyway.
    table(r.table_name).columns.push({
      name: r.column_name,
      ordinal: Number(r.ordinal),
      type: r.data_type,
      notNull: r.not_null === true || r.not_null === 't',
      default: r.default_expr ?? null,
    });
  }
  for (const r of constraints.rows) {
    table(r.table_name).constraints[r.constraint_name] = {
      contype: r.contype,
      definition: r.definition,
    };
  }
  for (const r of indexes.rows) {
    table(r.table_name).indexes[r.index_name] = { definition: r.definition };
  }
  return snapshot;
}

// --- Pure diff --------------------------------------------------------------

function colByName(table) {
  const out = {};
  for (const c of table.columns) out[c.name] = c;
  return out;
}

function columnChanged(a, b) {
  return a.type !== b.type || a.notNull !== b.notNull || a.default !== b.default;
}

/** Diff one table's columns/constraints/indexes. Returns null if identical. */
function diffTable(from, to) {
  const fromCols = colByName(from);
  const toCols = colByName(to);

  const columns = { added: [], dropped: [], changed: [] };
  for (const c of to.columns) {
    if (!fromCols[c.name]) columns.added.push(c);
    else if (columnChanged(fromCols[c.name], c)) {
      columns.changed.push({ name: c.name, from: fromCols[c.name], to: c });
    }
  }
  for (const c of from.columns) {
    if (!toCols[c.name]) columns.dropped.push(c);
  }

  const diffNamed = (fromMap, toMap) => {
    const added = [], dropped = [], changed = [];
    for (const name of Object.keys(toMap)) {
      if (!fromMap[name]) added.push({ name, ...toMap[name] });
      else if (fromMap[name].definition !== toMap[name].definition) {
        changed.push({ name, from: fromMap[name], to: toMap[name] });
      }
    }
    for (const name of Object.keys(fromMap)) {
      if (!toMap[name]) dropped.push({ name, ...fromMap[name] });
    }
    return { added, dropped, changed };
  };

  const constraints = diffNamed(from.constraints, to.constraints);
  const indexes = diffNamed(from.indexes, to.indexes);

  const empty = (d) => d.added.length === 0 && d.dropped.length === 0 && d.changed.length === 0;
  if (empty(columns) && empty(constraints) && empty(indexes)) return null;
  return { columns, constraints, indexes };
}

/**
 * Structured diff for the side-by-side viewer. `tables.added` are in `to` only,
 * `tables.dropped` in `from` only, and `changed` is one entry per table present
 * in both that differs.
 */
function diffSchemas(from, to) {
  const fromNames = Object.keys(from.tables);
  const toNames = Object.keys(to.tables);
  const fromSet = new Set(fromNames);
  const toSet = new Set(toNames);

  const added = toNames.filter((n) => !fromSet.has(n)).sort();
  const dropped = fromNames.filter((n) => !toSet.has(n)).sort();

  const changed = [];
  for (const name of toNames.filter((n) => fromSet.has(n)).sort()) {
    const d = diffTable(from.tables[name], to.tables[name]);
    if (d) changed.push({ table: name, ...d });
  }
  return { tables: { added, dropped }, changed };
}

// --- Pure migration builder -------------------------------------------------

function columnDef(schema, table, col) {
  let def = `${quoteIdent(col.name)} ${col.type}`;
  if (col.notNull) def += ' NOT NULL';
  if (col.default != null) def += ` DEFAULT ${col.default}`;
  return def;
}

function createTableSql(schema, name, table) {
  const cols = table.columns.map((c) => `  ${columnDef(schema, name, c)}`).join(',\n');
  return `CREATE TABLE ${quoteQualifiedIdent(schema, name)} (\n${cols}\n);`;
}

// ALTER statements to turn column `from` into `to` (type/null/default).
function alterColumnSql(schema, table, from, to) {
  const t = quoteQualifiedIdent(schema, table);
  const col = quoteIdent(to.name);
  const out = [];
  if (from.type !== to.type) {
    // Type changes can be lossy/rewrite the table — always flagged destructive.
    out.push({ sql: `ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${to.type};`, destructive: true, kind: 'alter_column_type' });
  }
  if (from.notNull !== to.notNull) {
    out.push({
      sql: `ALTER TABLE ${t} ALTER COLUMN ${col} ${to.notNull ? 'SET' : 'DROP'} NOT NULL;`,
      destructive: false, kind: 'alter_column_null',
    });
  }
  if (from.default !== to.default) {
    out.push({
      sql: to.default != null
        ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${to.default};`
        : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`,
      destructive: false, kind: 'alter_column_default',
    });
  }
  return out;
}

const isFk = (c) => c.contype === 'f';

/**
 * Ordered statement list transforming `from` into `to`. Each statement carries a
 * `destructive` flag (DROP TABLE/COLUMN/CONSTRAINT/INDEX and column-type changes)
 * so the UI can flag it red and the user can review before running.
 *
 * Order is dependency-aware enough for the common cases: create tables and add
 * columns before touching them; drop foreign keys and indexes before dropping
 * the columns/tables under them; add non-FK constraints before FKs; drop columns
 * and tables last.
 *
 * ponytail: this does NOT topologically sort the FK graph (e.g. a chain of new
 * tables referencing each other added in the wrong order). Nothing here is
 * executed — the user reviews and reorders in the editor if Postgres complains.
 * Upgrade to a real dependency sort if that proves common.
 */
function buildMigration(from, to) {
  const diff = diffSchemas(from, to);
  const schema = from.schema;

  const create = [];          // 1. CREATE TABLE (new tables, columns only)
  const addColumn = [];       // 2. ADD COLUMN
  const alterColumn = [];     // 3. ALTER COLUMN
  const dropConstraint = [];  // 4. DROP CONSTRAINT
  const dropIndex = [];       // 5. DROP INDEX
  const addConstraint = [];   // 6. ADD CONSTRAINT (non-FK)
  const addFk = [];           // 6b. ADD CONSTRAINT (FK, after non-FK)
  const createIndex = [];     // 7. CREATE INDEX
  const dropColumn = [];      // 8. DROP COLUMN (destructive)
  const dropTable = [];       // 9. DROP TABLE (destructive)

  const addConstraintStmt = (table, name, c) => {
    const stmt = {
      sql: `ALTER TABLE ${quoteQualifiedIdent(schema, table)} ADD CONSTRAINT ${quoteIdent(name)} ${c.definition};`,
      destructive: false,
      kind: 'add_constraint',
    };
    (isFk(c) ? addFk : addConstraint).push(stmt);
  };
  const dropConstraintStmt = (table, name) => {
    dropConstraint.push({
      sql: `ALTER TABLE ${quoteQualifiedIdent(schema, table)} DROP CONSTRAINT ${quoteIdent(name)};`,
      destructive: true,
      kind: 'drop_constraint',
    });
  };

  // New tables: CREATE, then all their constraints + indexes.
  for (const name of diff.tables.added) {
    const t = to.tables[name];
    create.push({ sql: createTableSql(schema, name, t), destructive: false, kind: 'create_table' });
    for (const [cname, c] of Object.entries(t.constraints)) addConstraintStmt(name, cname, c);
    for (const ix of Object.values(t.indexes)) {
      createIndex.push({ sql: ensureSemicolon(ix.definition), destructive: false, kind: 'create_index' });
    }
  }

  // Dropped tables.
  for (const name of diff.tables.dropped) {
    dropTable.push({
      sql: `DROP TABLE ${quoteQualifiedIdent(schema, name)};`,
      destructive: true,
      kind: 'drop_table',
    });
  }

  // Changed tables.
  for (const ch of diff.changed) {
    const t = ch.table;
    for (const c of ch.columns.added) {
      addColumn.push({
        sql: `ALTER TABLE ${quoteQualifiedIdent(schema, t)} ADD COLUMN ${columnDef(schema, t, c)};`,
        destructive: false, kind: 'add_column',
      });
    }
    for (const c of ch.columns.changed) {
      alterColumn.push(...alterColumnSql(schema, t, c.from, c.to));
    }
    for (const c of ch.columns.dropped) {
      dropColumn.push({
        sql: `ALTER TABLE ${quoteQualifiedIdent(schema, t)} DROP COLUMN ${quoteIdent(c.name)};`,
        destructive: true, kind: 'drop_column',
      });
    }

    // Constraints: a changed constraint is drop + re-add.
    for (const c of ch.constraints.dropped) dropConstraintStmt(t, c.name);
    for (const c of ch.constraints.changed) dropConstraintStmt(t, c.name);
    for (const c of ch.constraints.added) addConstraintStmt(t, c.name, c);
    for (const c of ch.constraints.changed) addConstraintStmt(t, c.name, c.to);

    // Indexes: a changed index is drop + re-create.
    for (const ix of ch.indexes.dropped) dropIndexStmt(dropIndex, schema, ix.name);
    for (const ix of ch.indexes.changed) dropIndexStmt(dropIndex, schema, ix.name);
    for (const ix of ch.indexes.added) {
      createIndex.push({ sql: ensureSemicolon(ix.definition), destructive: false, kind: 'create_index' });
    }
    for (const ix of ch.indexes.changed) {
      createIndex.push({ sql: ensureSemicolon(ix.to.definition), destructive: false, kind: 'create_index' });
    }
  }

  const statements = [
    ...create, ...addColumn, ...alterColumn,
    ...dropConstraint, ...dropIndex,
    ...addConstraint, ...addFk, ...createIndex,
    ...dropColumn, ...dropTable,
  ];
  return { statements, hasDestructive: statements.some((s) => s.destructive) };
}

function dropIndexStmt(bucket, schema, name) {
  bucket.push({
    sql: `DROP INDEX ${quoteQualifiedIdent(schema, name)};`,
    destructive: true,
    kind: 'drop_index',
  });
}

// pg_get_indexdef has no trailing semicolon; CREATE TABLE etc. carry their own.
function ensureSemicolon(sql) {
  const t = sql.trimEnd();
  return t.endsWith(';') ? t : `${t};`;
}

module.exports = {
  introspectSchema,
  diffSchemas,
  buildMigration,
};
