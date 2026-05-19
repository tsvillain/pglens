const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { validate } = require('../../src/http/validate');

function run(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ called: 'json', res: this }); return this; },
    };
    const next = () => resolve({ called: 'next', res });
    mw(req, res, next);
  });
}

test('validate parses and replaces req.body', async () => {
  const mw = validate({ body: z.object({ n: z.number() }) });
  const req = { body: { n: 5 } };
  const out = await run(mw, req);
  assert.equal(out.called, 'next');
  assert.deepEqual(req.body, { n: 5 });
});

test('validate coerces query strings via z.coerce', async () => {
  const mw = validate({ query: z.object({ page: z.coerce.number().int() }) });
  const req = { query: { page: '3' } };
  const out = await run(mw, req);
  assert.equal(out.called, 'next');
  assert.equal(req.query.page, 3);
});

test('validate returns the VALIDATION envelope with offending paths', async () => {
  const mw = validate({ body: z.object({ url: z.string().min(1) }) });
  const req = { body: { url: '' } };
  const out = await run(mw, req);
  assert.equal(out.called, 'json');
  assert.equal(out.res.statusCode, 400);
  assert.equal(out.res.body.error.code, 'VALIDATION');
  assert.match(out.res.body.error.hint, /url:/);
});

test('validate falls through to BAD_REQUEST for non-Zod errors', async () => {
  const mw = validate({
    body: { parse() { throw new Error('boom'); } },
  });
  const out = await run(mw, { body: {} });
  assert.equal(out.res.statusCode, 400);
  assert.equal(out.res.body.error.code, 'BAD_REQUEST');
  assert.equal(out.res.body.error.message, 'boom');
});
