/**
 * Unit tests for Postgres-native role provisioning.
 *
 * buildProvisioningDdl/buildDeprovisioningDdl are pure — the interesting
 * cases are identifier escaping (the one security-relevant bit, since role
 * and schema names get interpolated) and that each access level emits
 * exactly the grants it should, no more. getSchemaOwner is exercised
 * against a fake pool matching by SQL substring, same pattern as
 * indexAdvisor.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateRolePassword,
  getSchemaOwner,
  buildProvisioningDdl,
  buildDeprovisioningDdl,
} = require('../../src/db/roleProvisioning');

function fakePool(rows) {
  return {
    query: async (sql, params) => {
      void params;
      if (sql.includes('pg_namespace')) {
        return { rows, fields: [], rowCount: rows.length, command: 'SELECT' };
      }
      return { rows: [], fields: [], rowCount: 0, command: 'SELECT' };
    },
  };
}

test('generateRolePassword returns distinct, sufficiently long values', () => {
  const a = generateRolePassword();
  const b = generateRolePassword();
  assert.notEqual(a, b);
  assert.ok(a.length >= 20);
});

test('getSchemaOwner returns the owning role name', async () => {
  const owner = await getSchemaOwner(fakePool([{ owner: 'app_owner' }]), 'public');
  assert.equal(owner, 'app_owner');
});

test('getSchemaOwner returns null when the schema is not found', async () => {
  const owner = await getSchemaOwner(fakePool([]), 'ghost');
  assert.equal(owner, null);
});

test('read level: SELECT only, forced read-only session, no write/DDL grants', () => {
  const { statements, destructive } = buildProvisioningDdl({
    schema: 'public', database: 'app', roleName: 'teammate_ro', accessLevel: 'read', password: 'x',
  });
  assert.equal(destructive, false);
  const joined = statements.join('\n');
  assert.match(joined, /CREATE ROLE "teammate_ro" LOGIN PASSWORD 'x';/);
  assert.match(joined, /GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "teammate_ro";/);
  assert.match(joined, /ALTER ROLE "teammate_ro" SET default_transaction_read_only = on;/);
  assert.doesNotMatch(joined, /INSERT|UPDATE|DELETE/);
  assert.doesNotMatch(joined, /GRANT CREATE ON SCHEMA/);
});

test('write level: adds DML grants, no read-only lock, no DDL', () => {
  const { statements } = buildProvisioningDdl({
    schema: 'public', database: 'app', roleName: 'teammate_rw', accessLevel: 'write', password: 'x',
  });
  const joined = statements.join('\n');
  assert.match(joined, /GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "teammate_rw";/);
  assert.doesNotMatch(joined, /default_transaction_read_only/);
  assert.doesNotMatch(joined, /GRANT CREATE ON SCHEMA/);
});

test('admin level: adds CREATE on schema and membership in the owning role', () => {
  const { statements } = buildProvisioningDdl({
    schema: 'public', database: 'app', roleName: 'teammate_admin',
    accessLevel: 'admin', ownerRole: 'app_owner', password: 'x',
  });
  const joined = statements.join('\n');
  assert.match(joined, /GRANT CREATE ON SCHEMA "public" TO "teammate_admin";/);
  assert.match(joined, /GRANT "app_owner" TO "teammate_admin";/);
});

test('admin level throws without an owner role — refuses to silently under-provision', () => {
  assert.throws(() => buildProvisioningDdl({
    schema: 'public', database: 'app', roleName: 'x', accessLevel: 'admin', password: 'x',
  }));
});

test('unsupported access level throws', () => {
  assert.throws(() => buildProvisioningDdl({
    schema: 'public', database: 'app', roleName: 'x', accessLevel: 'owner', password: 'x',
  }));
});

test('role and schema names are identifier-escaped, not interpolated raw', () => {
  const { statements } = buildProvisioningDdl({
    schema: 'public', database: 'app', roleName: 'weird"role', accessLevel: 'read', password: 'x',
  });
  assert.match(statements[0], /"weird""role"/);
});

test('buildDeprovisioningDdl drops the role and is flagged destructive', () => {
  const { statements, destructive } = buildDeprovisioningDdl('teammate_ro');
  assert.equal(destructive, true);
  assert.equal(statements[0], 'DROP ROLE IF EXISTS "teammate_ro";');
});
