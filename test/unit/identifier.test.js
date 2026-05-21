const test = require('node:test');
const assert = require('node:assert/strict');

const { quoteIdent, quoteQualifiedIdent } = require('../../src/db/identifier');

test('quoteIdent wraps a plain identifier in double quotes', () => {
  assert.equal(quoteIdent('users'), '"users"');
});

test('quoteIdent preserves mixed case (regression from the old regex allowlist)', () => {
  assert.equal(quoteIdent('AppCommunityCode'), '"AppCommunityCode"');
});

test('quoteIdent doubles embedded double quotes', () => {
  assert.equal(quoteIdent('weird"name'), '"weird""name"');
});

test('quoteIdent allows Unicode characters', () => {
  assert.equal(quoteIdent('café'), '"café"');
  assert.equal(quoteIdent('テーブル'), '"テーブル"');
});

test('quoteIdent rejects empty strings', () => {
  assert.throws(() => quoteIdent(''), /empty/);
});

test('quoteIdent rejects non-strings', () => {
  assert.throws(() => quoteIdent(123), /string/);
  assert.throws(() => quoteIdent(null), /string/);
});

test('quoteIdent rejects null bytes (SQL termination attack)', () => {
  assert.throws(() => quoteIdent('a\0b'), /null byte/);
});

test('quoteIdent rejects oversized identifiers', () => {
  assert.throws(() => quoteIdent('a'.repeat(300)), /maximum length/);
});

test('quoteQualifiedIdent quotes both halves', () => {
  assert.equal(quoteQualifiedIdent('public', 'users'), '"public"."users"');
});

test('quoteQualifiedIdent escapes both halves independently', () => {
  assert.equal(
    quoteQualifiedIdent('weird"schema', 'weird"table'),
    '"weird""schema"."weird""table"',
  );
});
