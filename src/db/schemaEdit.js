/**
 * Visual ERD editor → DDL (roadmap §7.2).
 *
 * The editable ERD produces a list of *structured* edit ops (never SQL strings —
 * see CLAUDE.md: no raw SQL fragments from the no-code UI). This module turns
 * those ops into reviewable DDL, escaping every identifier through the canonical
 * escaper. Like the schema-diff/index-assistant generators, nothing here runs:
 * the statements go to the editor behind the Run button, with a `destructive`
 * flag per statement so the UI can flag the dangerous ones red.
 *
 * Scope is "edit what's in your DB" (roadmap §12), so there is no CREATE TABLE —
 * only column add/alter/drop and adding a foreign key, the four actions §7.2
 * lists.
 */

const { quoteIdent, quoteQualifiedIdent } = require('./identifier');

// Type names aren't identifiers (no double-quoting), so they can't go through
// quoteIdent. They're also not user-free-form SQL — a conservative allowlist
// covers every real Postgres type spelling (int4, numeric(10,2), varchar(255),
// timestamptz, text[], "MySchema".my_enum) while blocking statement injection.
// ponytail: regex allowlist, not a type parser. Reject exotic spellings here and
// upgrade to pg_type validation only if a real one is ever turned away.
const TYPE_RE = /^[A-Za-z0-9_ ,().[\]"]+$/;
function validateType(type) {
  if (typeof type !== 'string' || type.length === 0 || type.length > 100 || !TYPE_RE.test(type)) {
    throw new Error(`Invalid column type: ${JSON.stringify(type)}`);
  }
  return type;
}

// A DEFAULT is a raw SQL expression and DDL can't be parameterized, so it gets a
// conservative allowlist: literals, numbers, and simple function calls
// (now(), gen_random_uuid(), 'text', 0, true). A semicolon — the only way to
// chain a second statement — is rejected outright.
// ponytail: allowlist, not an expression parser. Complex defaults (CASE, casts
// with ::, subqueries) are turned away; the user can add them in the editor.
const DEFAULT_RE = /^[A-Za-z0-9_'"().,:+\-* \[\]]+$/;
function validateDefault(expr) {
  if (typeof expr !== 'string' || expr.length === 0 || expr.length > 200 ||
      expr.includes('\0') || expr.includes(';') || !DEFAULT_RE.test(expr)) {
    throw new Error(`Invalid default expression: ${JSON.stringify(expr)}`);
  }
  return expr;
}

function columnDef(col) {
  let def = `${quoteIdent(col.name)} ${validateType(col.type)}`;
  if (col.notNull) def += ' NOT NULL';
  if (col.default != null) def += ` DEFAULT ${validateDefault(col.default)}`;
  return def;
}

/**
 * Turn one edit op into zero or more migration statements. `schema` is the
 * connection's configured schema; every table/column reference is escaped.
 */
function opToStatements(schema, op) {
  const q = (table) => quoteQualifiedIdent(schema, table);
  switch (op.op) {
    case 'add_column':
      return [{
        sql: `ALTER TABLE ${q(op.table)} ADD COLUMN ${columnDef(op.column)};`,
        destructive: false, kind: 'add_column',
      }];

    case 'alter_column': {
      const out = [];
      const t = q(op.table);
      // Rename first, then refer to the new name in the remaining alters so a
      // rename + retype in one op produces valid SQL.
      let name = op.name;
      if (op.rename && op.rename !== op.name) {
        out.push({
          sql: `ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(op.name)} TO ${quoteIdent(op.rename)};`,
          destructive: false, kind: 'rename_column',
        });
        name = op.rename;
      }
      const col = quoteIdent(name);
      if (op.type != null) {
        out.push({
          sql: `ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${validateType(op.type)};`,
          destructive: true, kind: 'alter_column_type',
        });
      }
      if (op.notNull != null) {
        out.push({
          sql: `ALTER TABLE ${t} ALTER COLUMN ${col} ${op.notNull ? 'SET' : 'DROP'} NOT NULL;`,
          destructive: false, kind: 'alter_column_null',
        });
      }
      if (op.default !== undefined) {
        out.push({
          sql: op.default === null
            ? `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`
            : `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${validateDefault(op.default)};`,
          destructive: false, kind: 'alter_column_default',
        });
      }
      return out;
    }

    case 'drop_column':
      return [{
        sql: `ALTER TABLE ${q(op.table)} DROP COLUMN ${quoteIdent(op.name)};`,
        destructive: true, kind: 'drop_column',
      }];

    case 'add_foreign_key': {
      const name = op.name || `fk_${op.table}_${op.column}`;
      return [{
        sql: `ALTER TABLE ${q(op.table)} ADD CONSTRAINT ${quoteIdent(name)} ` +
          `FOREIGN KEY (${quoteIdent(op.column)}) ` +
          `REFERENCES ${q(op.refTable)} (${quoteIdent(op.refColumn)});`,
        destructive: false, kind: 'add_foreign_key',
      }];
    }

    case 'drop_foreign_key':
      return [{
        sql: `ALTER TABLE ${q(op.table)} DROP CONSTRAINT ${quoteIdent(op.name)};`,
        destructive: true, kind: 'drop_foreign_key',
      }];

    default:
      throw new Error(`Unknown edit op: ${op.op}`);
  }
}

function buildEditDDL(schema, ops) {
  const statements = ops.flatMap((op) => opToStatements(schema, op));
  return { statements, hasDestructive: statements.some((s) => s.destructive) };
}

module.exports = { buildEditDDL, validateType, validateDefault };
