/**
 * Advanced-mode transaction sessions (roadmap §5.3).
 *
 * In Transaction mode an Advanced tab holds a single dedicated Postgres backend
 * (porsager's `reserve()`) for the life of the transaction rather than
 * borrowing a pooled connection per query. `BEGIN` is issued lazily on the
 * tab's first query; the same backend then serves COMMIT/ROLLBACK, so the whole
 * tab is one atomic unit of work.
 *
 * Sessions are parked in a server-side map keyed by tab id. The auth middleware
 * gates every request behind the single per-install token, so the map is
 * inherently scoped to this install (roadmap §5.3: "keyed by the per-install
 * token + tab id"). A session is bound to the connection it opened against; a
 * request for the same tab on a *different* connection is rejected rather than
 * silently orphaning the held backend.
 *
 * A reserved backend is finite (the pool only has `max` of them), so each idle
 * session self-destructs after `idleTimeoutMs` — a tab left open overnight
 * rolls back and frees its connection instead of pinning it forever.
 */

const logger = require('../log');
const { quoteIdent } = require('./identifier');
const { reserveConnection, onPoolClosing } = require('./connection');

// A tab idle this long has its transaction rolled back and its backend returned
// to the pool. Reset on every query.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function conflict(message) {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = 'CONFLICT';
  return err;
}

/**
 * Build a transaction-session manager over a `reserveConnection(connectionId)`
 * function. Exposed as a factory (rather than a bare singleton) so tests can
 * inject a fake reserve and a short idle timeout.
 */
function createTxManager({ reserveConnection: reserve, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  // tabId -> session. A session exists only while a transaction is open.
  //   session = { tabId, connectionId, reserved, busy, idleTimer, ready }
  const sessions = new Map();

  function clearIdle(session) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  function armIdle(session) {
    clearIdle(session);
    session.idleTimer = setTimeout(() => {
      logger.warn({ tabId: session.tabId }, 'transaction idle timeout — rolling back');
      void teardownQuiet(session, 'ROLLBACK');
    }, idleTimeoutMs);
    // Don't let a parked transaction keep the process alive.
    if (session.idleTimer.unref) session.idleTimer.unref();
  }

  // Remove the session from the map and hand back its reserved backend (or null
  // if open() never finished checking one out).
  function detach(session) {
    if (sessions.get(session.tabId) === session) sessions.delete(session.tabId);
    clearIdle(session);
    const reserved = session.reserved;
    session.reserved = null;
    return reserved;
  }

  // Best-effort teardown for idle timeout / pool close: roll back if we can,
  // always release, never throw.
  async function teardownQuiet(session, stmt) {
    const reserved = detach(session);
    if (!reserved) return;
    try {
      await reserved.query(stmt);
    } catch (err) {
      logger.warn({ tabId: session.tabId, err: err.message }, `transaction ${stmt} failed`);
    } finally {
      try { reserved.release(); } catch { /* already released */ }
    }
  }

  // Open a fresh session: reserve a backend, pin search_path, BEGIN. The session
  // is registered synchronously (before the first await) so a racing query for
  // the same tab joins this session instead of reserving a second backend.
  function open(connectionId, tabId, schema) {
    const session = { tabId, connectionId, reserved: null, busy: false, idleTimer: null, ready: null };
    session.ready = (async () => {
      const reserved = await reserve(connectionId);
      if (!reserved) {
        const err = new Error('Not connected to database or invalid connection ID');
        err.statusCode = 503;
        err.code = 'NO_CONNECTION';
        throw err;
      }
      try {
        // search_path is pinned outside the transaction so it survives the whole
        // session regardless of how the transaction ends.
        await reserved.query(`SET search_path TO ${quoteIdent(schema)}`);
        await reserved.query('BEGIN');
      } catch (err) {
        try { reserved.release(); } catch { /* ignore */ }
        throw err;
      }
      session.reserved = reserved;
      return session;
    })();
    sessions.set(tabId, session);
    return session;
  }

  async function getSession(connectionId, tabId, schema) {
    const existing = sessions.get(tabId);
    if (existing) {
      if (existing.connectionId !== connectionId) {
        throw conflict(
          'A transaction is open on a different connection for this tab. Commit or roll back first.',
        );
      }
      await existing.ready; // wait for BEGIN (and surface an open() failure)
      return existing;
    }
    const session = open(connectionId, tabId, schema);
    try {
      await session.ready;
    } catch (err) {
      sessions.delete(tabId);
      throw err;
    }
    return session;
  }

  /**
   * Run a statement inside the tab's transaction, opening it (implicit BEGIN) on
   * first use. On a statement error the session is left open so the user can
   * roll back the aborted transaction; the idle timer is re-armed either way.
   */
  async function runQuery({ connectionId, tabId, schema, sql, params }) {
    const session = await getSession(connectionId, tabId, schema);
    if (session.busy) {
      throw conflict('A query is already running in this transaction.');
    }
    session.busy = true;
    clearIdle(session);
    try {
      return await session.reserved.query(sql, params);
    } finally {
      session.busy = false;
      if (sessions.get(tabId) === session) armIdle(session);
    }
  }

  // COMMIT / ROLLBACK. Propagates a failing COMMIT (e.g. deferred constraint) so
  // the user learns the transaction didn't land; the backend is released either
  // way. No-op (hadTransaction: false) when the tab has no open transaction.
  async function finish(connectionId, tabId, stmt) {
    const session = sessions.get(tabId);
    if (!session) return { hadTransaction: false };
    if (session.connectionId !== connectionId) {
      throw conflict('That transaction is open on a different connection.');
    }
    await session.ready.catch(() => {}); // let a pending BEGIN settle first
    const reserved = detach(session);
    if (!reserved) return { hadTransaction: true };
    try {
      await reserved.query(stmt);
      return { hadTransaction: true };
    } finally {
      try { reserved.release(); } catch { /* ignore */ }
    }
  }

  function commit(connectionId, tabId) {
    return finish(connectionId, tabId, 'COMMIT');
  }

  function rollback(connectionId, tabId) {
    return finish(connectionId, tabId, 'ROLLBACK');
  }

  function status(tabId) {
    const session = sessions.get(tabId);
    return { open: !!session, connectionId: session ? session.connectionId : null };
  }

  // Called when a pool is closing: roll back + release every session on that
  // connection (or all of them when connectionId is null).
  async function disposeForConnection(connectionId) {
    const victims = [...sessions.values()].filter(
      (s) => connectionId == null || s.connectionId === connectionId,
    );
    await Promise.all(victims.map((s) => teardownQuiet(s, 'ROLLBACK')));
  }

  return { runQuery, commit, rollback, status, disposeForConnection };
}

// Singleton wired to the real connection pool. Registers a pool-close hook so
// disconnect / connection-update / shutdown roll back open transactions and
// free their backends before the pool ends.
const txManager = createTxManager({ reserveConnection });
onPoolClosing((connectionId) => txManager.disposeForConnection(connectionId));

module.exports = { createTxManager, txManager };
