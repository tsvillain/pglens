const test = require('node:test');
const assert = require('node:assert/strict');

const { sendError, codes } = require('../../src/http/errors');

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('sendError returns the structured envelope', () => {
  const res = fakeRes();
  sendError(res, 400, codes.BAD_REQUEST, 'oops');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'BAD_REQUEST');
  assert.equal(res.body.error.message, 'oops');
});

test('sendError mirrors the message in errorMessage for the v2 client', () => {
  const res = fakeRes();
  sendError(res, 500, codes.INTERNAL, 'boom');
  assert.equal(res.body.errorMessage, 'boom');
});

test('sendError includes hint only when provided', () => {
  const res1 = fakeRes();
  sendError(res1, 400, codes.BAD_REQUEST, 'oops');
  assert.equal(res1.body.error.hint, undefined);

  const res2 = fakeRes();
  sendError(res2, 400, codes.BAD_REQUEST, 'oops', { hint: 'try X' });
  assert.equal(res2.body.error.hint, 'try X');
});

test('codes table includes the major statuses', () => {
  for (const key of ['BAD_REQUEST', 'UNAUTHENTICATED', 'NO_CONNECTION', 'DB_ERROR', 'VALIDATION', 'INTERNAL']) {
    assert.equal(typeof codes[key], 'string');
  }
});
