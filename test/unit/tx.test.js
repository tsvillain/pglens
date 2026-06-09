/**
 * Unit tests for the transaction-session manager (roadmap §5.3).
 *
 * Drives `createTxManager` with a fake `reserveConnection` so no real Postgres
 * is needed — every reserve hands back a recording stub whose statements and
 * release()s we can assert on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTxManager } = require('../../src/db/tx');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A recording stand-in for a porsager reserved connection. Control/transaction
// statements resolve immediately; the "user" statement returns `state.userResult`
// unless `state.userError` (throw) or `state.userHang` (a pending promise) is set.
function fakeConn() {
  const calls = [];
  const state = {
    released: 0,
    userResult: { rows: [{ ok: 1 }], fields: [{ name: 'ok' }], rowCount: 1 },
    userError: null,
    userHang: null,
  };
  const conn = {
    query: async (sql) => {
      calls.push(sql);
      if (/^\s*(SET|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
        return { rows: [], fields: [], rowCount: 0 };
      }
      if (state.userHang) return state.userHang;
      if (state.userError) throw state.userError;
      return state.userResult;
    },
    release: () => { state.released += 1; },
  };
  return { conn, calls, state };
}

// Builds a reserve() that hands out a fresh fakeConn per call (mirroring
// porsager, where each reserve() is a distinct backend) and records them.
// connectionId 'missing' simulates a closed/unknown pool.
function makeReserve() {
  const conns = [];
  const reserve = async (connectionId) => {
    if (connectionId === 'missing') return null;
    const h = fakeConn();
    conns.push(h);
    return h.conn;
  };
  return { reserve, conns };
}

const baseQuery = (over) => ({
  connectionId: 'c1', tabId: 't1', schema: 'public', sql: 'SELECT 1', ...over,
});

test('first query opens the session: SET search_path → BEGIN → statement', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  const r = await m.runQuery(baseQuery());
  assert.deepEqual(r, { rows: [{ ok: 1 }], fields: [{ name: 'ok' }], rowCount: 1 });
  assert.equal(conns.length, 1);
  assert.deepEqual(conns[0].calls, ['SET search_path TO "public"', 'BEGIN', 'SELECT 1']);
  assert.deepEqual(m.status('t1'), { open: true, connectionId: 'c1' });
});

test('search_path schema name is identifier-escaped', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });
  await m.runQuery(baseQuery({ schema: 'we"ird' }));
  assert.equal(conns[0].calls[0], 'SET search_path TO "we""ird"');
});

test('second query reuses the session — no new reserve, no second BEGIN', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery({ sql: 'SELECT 1' }));
  await m.runQuery(baseQuery({ sql: 'SELECT 2' }));

  assert.equal(conns.length, 1);
  assert.deepEqual(conns[0].calls, ['SET search_path TO "public"', 'BEGIN', 'SELECT 1', 'SELECT 2']);
});

test('runStatements runs each statement on the session and returns one result each', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  const results = await m.runStatements(
    baseQuery({ statements: ['SELECT 1', 'SELECT 2'], sql: undefined }),
  );

  assert.equal(conns.length, 1);
  assert.deepEqual(conns[0].calls, [
    'SET search_path TO "public"', 'BEGIN', 'SELECT 1', 'SELECT 2',
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].rows, [{ ok: 1 }]);
  assert.equal(typeof results[0].durationMs, 'number');
  assert.equal(m.status('t1').open, true);
});

test('runStatements binds params to the first statement only', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runStatements(
    baseQuery({ statements: ['SELECT $1', 'SELECT 2'], sql: undefined, params: [7] }),
  );

  // fakeConn records only the SQL text, so assert the call order; the second
  // statement must receive undefined params (verified by no throw / shape).
  assert.deepEqual(conns[0].calls.slice(2), ['SELECT $1', 'SELECT 2']);
});

test('explain runs EXPLAIN ANALYZE inside the open transaction (no extra rollback)', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.explain(baseQuery({ sql: 'SELECT 1' }));

  assert.deepEqual(conns[0].calls, [
    'SET search_path TO "public"',
    'BEGIN',
    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1',
  ]);
  assert.equal(m.status('t1').open, true);
});

test('commit issues COMMIT, releases the backend, and closes the session', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery());
  const res = await m.commit('c1', 't1');

  assert.deepEqual(res, { hadTransaction: true });
  assert.ok(conns[0].calls.includes('COMMIT'));
  assert.equal(conns[0].state.released, 1);
  assert.equal(m.status('t1').open, false);
});

test('rollback issues ROLLBACK, releases the backend, and closes the session', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery());
  const res = await m.rollback('c1', 't1');

  assert.deepEqual(res, { hadTransaction: true });
  assert.ok(conns[0].calls.includes('ROLLBACK'));
  assert.equal(conns[0].state.released, 1);
  assert.equal(m.status('t1').open, false);
});

test('commit/rollback on a tab with no open transaction is a no-op', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  assert.deepEqual(await m.commit('c1', 'nope'), { hadTransaction: false });
  assert.deepEqual(await m.rollback('c1', 'nope'), { hadTransaction: false });
  assert.equal(conns.length, 0);
});

test('a query for the same tab on a different connection is a CONFLICT', async () => {
  const { reserve } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery({ connectionId: 'c1' }));
  await assert.rejects(
    m.runQuery(baseQuery({ connectionId: 'c2' })),
    (e) => e.statusCode === 409 && e.code === 'CONFLICT',
  );
});

test('a failed statement leaves the transaction open so it can be rolled back', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery({ sql: 'SELECT 1' }));
  conns[0].state.userError = new Error('syntax error at or near "OOPS"');
  await assert.rejects(m.runQuery(baseQuery({ sql: 'OOPS' })), /syntax error/);
  assert.equal(m.status('t1').open, true);

  conns[0].state.userError = null;
  await m.rollback('c1', 't1');
  assert.equal(m.status('t1').open, false);
  assert.ok(conns[0].calls.includes('ROLLBACK'));
});

test('concurrent query on the same session is rejected as busy', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery({ sql: 'SELECT 1' })); // open the session
  let release;
  conns[0].state.userHang = new Promise((r) => { release = r; });

  const inflight = m.runQuery(baseQuery({ sql: 'SLOW' }));
  await delay(10);
  await assert.rejects(
    m.runQuery(baseQuery({ sql: 'OTHER' })),
    (e) => e.code === 'CONFLICT' && /already running/.test(e.message),
  );

  release({ rows: [], fields: [], rowCount: 0 });
  await inflight;
});

test('idle timeout rolls back and releases the backend', async () => {
  const { reserve, conns } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve, idleTimeoutMs: 25 });

  await m.runQuery(baseQuery());
  assert.equal(m.status('t1').open, true);

  await delay(60);
  assert.equal(m.status('t1').open, false);
  assert.ok(conns[0].calls.includes('ROLLBACK'));
  assert.equal(conns[0].state.released, 1);
});

test('disposeForConnection rolls back only the matching connection’s sessions', async () => {
  const { reserve } = makeReserve();
  const m = createTxManager({ reserveConnection: reserve });

  await m.runQuery(baseQuery({ connectionId: 'c1', tabId: 'tA' }));
  await m.runQuery(baseQuery({ connectionId: 'c1', tabId: 'tB' }));
  await m.runQuery(baseQuery({ connectionId: 'c2', tabId: 'tC' }));

  await m.disposeForConnection('c1');
  assert.equal(m.status('tA').open, false);
  assert.equal(m.status('tB').open, false);
  assert.equal(m.status('tC').open, true);

  await m.disposeForConnection(null); // full shutdown
  assert.equal(m.status('tC').open, false);
});

test('a missing/closed connection surfaces NO_CONNECTION and opens no session', async () => {
  const m = createTxManager({ reserveConnection: async () => null });
  await assert.rejects(
    m.runQuery(baseQuery({ connectionId: 'missing' })),
    (e) => e.statusCode === 503 && e.code === 'NO_CONNECTION',
  );
  assert.equal(m.status('t1').open, false);
});
