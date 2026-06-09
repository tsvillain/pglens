/**
 * Unit tests for the SQL script splitter (roadmap §5.4 multi-statement results).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitStatements } = require('../../src/db/statements');

test('splits simple semicolon-separated statements', () => {
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
});

test('single statement with no terminator', () => {
  assert.deepEqual(splitStatements('SELECT 1'), ['SELECT 1']);
});

test('trims whitespace and drops the trailing semicolon', () => {
  assert.deepEqual(splitStatements('  SELECT 1 ;  '), ['SELECT 1']);
});

test('drops empty statements from doubled/trailing semicolons', () => {
  assert.deepEqual(splitStatements('SELECT 1;;SELECT 2;'), ['SELECT 1', 'SELECT 2']);
});

test('empty or whitespace-only input yields no statements', () => {
  assert.deepEqual(splitStatements(''), []);
  assert.deepEqual(splitStatements('   \n  '), []);
  assert.deepEqual(splitStatements(';;;'), []);
});

test('drops comment-only statements', () => {
  assert.deepEqual(splitStatements('-- just a note'), []);
  assert.deepEqual(splitStatements('/* block */; SELECT 1'), ['SELECT 1']);
});

test('keeps a leading comment attached to its statement', () => {
  assert.deepEqual(
    splitStatements('-- get one\nSELECT 1;'),
    ['-- get one\nSELECT 1'],
  );
});

test('ignores semicolons inside single-quoted strings', () => {
  assert.deepEqual(
    splitStatements("SELECT 'a;b'; SELECT 2"),
    ["SELECT 'a;b'", 'SELECT 2'],
  );
});

test('handles doubled single quotes inside a string', () => {
  assert.deepEqual(
    splitStatements("SELECT 'it''s; fine'; SELECT 2"),
    ["SELECT 'it''s; fine'", 'SELECT 2'],
  );
});

test('handles backslash escapes inside an E-string', () => {
  assert.deepEqual(
    splitStatements("SELECT E'a\\';b'; SELECT 2"),
    ["SELECT E'a\\';b'", 'SELECT 2'],
  );
});

test('ignores semicolons inside quoted identifiers', () => {
  assert.deepEqual(
    splitStatements('SELECT 1 AS "a;b"; SELECT 2'),
    ['SELECT 1 AS "a;b"', 'SELECT 2'],
  );
});

test('ignores semicolons inside line comments', () => {
  assert.deepEqual(
    splitStatements('SELECT 1; -- a; b\nSELECT 2'),
    ['SELECT 1', '-- a; b\nSELECT 2'],
  );
});

test('ignores semicolons inside block comments', () => {
  assert.deepEqual(
    splitStatements('SELECT 1 /* a; b */; SELECT 2'),
    ['SELECT 1 /* a; b */', 'SELECT 2'],
  );
});

test('handles nested block comments', () => {
  assert.deepEqual(
    splitStatements('SELECT 1 /* a /* b; c */ d */; SELECT 2'),
    ['SELECT 1 /* a /* b; c */ d */', 'SELECT 2'],
  );
});

test('keeps a dollar-quoted function body intact', () => {
  const sql =
    "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()";
  assert.deepEqual(splitStatements(sql), [
    "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql",
    'SELECT f()',
  ]);
});

test('keeps a tagged dollar-quoted body intact', () => {
  const sql = "SELECT $tag$ a;b $tag$; SELECT 2";
  assert.deepEqual(splitStatements(sql), ['SELECT $tag$ a;b $tag$', 'SELECT 2']);
});

test('does not treat positional parameters as dollar-quotes', () => {
  assert.deepEqual(
    splitStatements('SELECT $1; SELECT $2'),
    ['SELECT $1', 'SELECT $2'],
  );
});
