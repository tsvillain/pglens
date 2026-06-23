/**
 * Live activity dashboard — Postgres-native operations (roadmap §6.1).
 *
 * Read-only introspection of the server's own catalogs/stats views, surfaced
 * in the "Operations" panel and polled every few seconds by the client:
 *
 *   - Active sessions      → pg_stat_activity
 *   - Locks & blocking     → pg_blocking_pids() + pg_stat_activity
 *   - Replication status   → pg_stat_replication (lag in bytes and seconds)
 *   - Database/table sizes → pg_total_relation_size() etc. (top N, index split out)
 *   - Connection count     → pg_stat_activity vs. max_connections (warn at 80%)
 *
 * Plus two privileged actions on a chosen backend: cancel the running query
 * (pg_cancel_backend) or terminate the whole session (pg_terminate_backend).
 *
 * Every function takes the wrapped pool from `requireConnection` (req.pool) and
 * runs parameterized queries against system views — no caller-supplied SQL ever
 * reaches the server. Each reader degrades independently in getOverview() so a
 * role lacking, say, replication visibility still gets the rest of the panel.
 */

// Long queries are truncated server-side so a busy server's payload stays small;
// the grid truncates further for display.
const QUERY_TRUNCATE = 2000;

// Top-N tables shown in the size panel (roadmap §6.1: "top 20 tables by size").
const TOP_TABLES = 20;

// Connection-count warning threshold (roadmap §6.1: "warning at 80%").
const CONN_WARN_RATIO = 0.8;

/**
 * Active sessions in the current database, newest query first. `pg_backend_pid()`
 * is excluded so the dashboard never offers to terminate the very connection it
 * is polling on. Idle time / age are derived from the timestamp columns client-side.
 */
async function getActivity(pool) {
  const { rows } = await pool.query(
    `SELECT pid,
            usename,
            application_name,
            client_addr::text AS client_addr,
            state,
            wait_event_type,
            wait_event,
            backend_type,
            left(query, $1) AS query,
            backend_start,
            xact_start,
            query_start,
            state_change,
            EXTRACT(EPOCH FROM (now() - backend_start))  AS age_seconds,
            EXTRACT(EPOCH FROM (now() - state_change))   AS state_age_seconds
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
      ORDER BY query_start DESC NULLS LAST`,
    [QUERY_TRUNCATE],
  );
  return rows;
}

/**
 * Blocker → blocked chains derived from pg_blocking_pids(). One row per
 * (blocked, blocking) pair so the client can render the wait graph.
 */
async function getBlocking(pool) {
  const { rows } = await pool.query(
    `SELECT blocked.pid                        AS blocked_pid,
            blocked.usename                    AS blocked_user,
            left(blocked.query, $1)            AS blocked_query,
            blocked.wait_event_type            AS wait_event_type,
            blocked.wait_event                 AS wait_event,
            blocking.pid                       AS blocking_pid,
            blocking.usename                   AS blocking_user,
            left(blocking.query, $1)           AS blocking_query,
            blocking.state                     AS blocking_state
       FROM pg_stat_activity blocked
       JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bp(pid) ON true
       JOIN pg_stat_activity blocking ON blocking.pid = bp.pid
      WHERE blocked.datname = current_database()
      ORDER BY blocked.pid`,
    [QUERY_TRUNCATE],
  );
  return rows;
}

/**
 * Replication standbys with lag in bytes (from LSN diff) and seconds. Empty on
 * a primary with no standbys, or for a role without replication visibility.
 */
async function getReplication(pool) {
  const { rows } = await pool.query(
    `SELECT pid,
            usename,
            application_name,
            client_addr::text AS client_addr,
            state,
            sync_state,
            sent_lsn::text   AS sent_lsn,
            replay_lsn::text AS replay_lsn,
            pg_wal_lsn_diff(sent_lsn, replay_lsn)        AS lag_bytes,
            EXTRACT(EPOCH FROM write_lag)   AS write_lag_seconds,
            EXTRACT(EPOCH FROM flush_lag)   AS flush_lag_seconds,
            EXTRACT(EPOCH FROM replay_lag)  AS replay_lag_seconds
       FROM pg_stat_replication
      ORDER BY pid`,
    [],
  );
  return rows;
}

/**
 * Database size plus the top-N relations in `schema` by total size, with the
 * heap / index / toast bytes broken out (roadmap §6.1: "index sizes broken out").
 */
async function getSizes(pool, schema) {
  const db = await pool.query(
    `SELECT current_database()                          AS name,
            pg_database_size(current_database())        AS bytes,
            pg_size_pretty(pg_database_size(current_database())) AS pretty`,
    [],
  );
  const tables = await pool.query(
    `SELECT c.relname                                            AS name,
            pg_total_relation_size(c.oid)                        AS total_bytes,
            pg_table_size(c.oid)                                 AS table_bytes,
            pg_indexes_size(c.oid)                               AS index_bytes,
            pg_size_pretty(pg_total_relation_size(c.oid))        AS total_pretty
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p', 'm')
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT $2`,
    [schema, TOP_TABLES],
  );
  return { database: db.rows[0] ?? null, tables: tables.rows };
}

/**
 * Classify connection usage against max_connections. Pure so it is unit-tested
 * and the 80% threshold lives in exactly one place (used here and exposed).
 */
function connectionUsageLevel(total, max) {
  if (!max || max <= 0) return 'ok';
  return total / max >= CONN_WARN_RATIO ? 'warn' : 'ok';
}

/**
 * Connection counts (total + by-state) against the server's max_connections,
 * with the warning level pre-computed so every surface shares one threshold.
 */
async function getConnectionStats(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int                                                    AS total,
            count(*) FILTER (WHERE state = 'active')::int                    AS active,
            count(*) FILTER (WHERE state = 'idle')::int                      AS idle,
            count(*) FILTER (WHERE state = 'idle in transaction')::int       AS idle_in_transaction,
            (SELECT setting::int FROM pg_settings WHERE name = 'max_connections')                 AS max,
            (SELECT setting::int FROM pg_settings WHERE name = 'superuser_reserved_connections')  AS reserved
       FROM pg_stat_activity
      WHERE datname = current_database()`,
    [],
  );
  const row = rows[0] ?? {};
  return { ...row, level: connectionUsageLevel(row.total, row.max) };
}

/**
 * Assemble the whole dashboard in one round trip. Readers run in parallel and
 * each is isolated: a section that throws (e.g. replication on a restricted
 * role) comes back as `{ data: null, error }` so the rest of the panel renders.
 */
async function getOverview(pool, schema) {
  const readers = {
    activity: () => getActivity(pool),
    blocking: () => getBlocking(pool),
    replication: () => getReplication(pool),
    sizes: () => getSizes(pool, schema),
    connections: () => getConnectionStats(pool),
  };
  const entries = await Promise.all(
    Object.entries(readers).map(async ([key, run]) => {
      try {
        return [key, { data: await run(), error: null }];
      } catch (err) {
        return [key, { data: null, error: err.message }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Cancel the running query on `pid` (pg_cancel_backend) — the gentle stop that
 * leaves the session connected. Returns whether Postgres signalled the backend.
 */
async function cancelBackend(pool, pid) {
  const { rows } = await pool.query('SELECT pg_cancel_backend($1) AS ok', [pid]);
  return { cancelled: rows[0]?.ok === true };
}

/**
 * Terminate the whole session on `pid` (pg_terminate_backend) — the hard stop
 * that drops the connection. Returns whether Postgres signalled the backend.
 */
async function terminateBackend(pool, pid) {
  const { rows } = await pool.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
  return { terminated: rows[0]?.ok === true };
}

module.exports = {
  getActivity,
  getBlocking,
  getReplication,
  getSizes,
  getConnectionStats,
  getOverview,
  cancelBackend,
  terminateBackend,
  connectionUsageLevel,
  TOP_TABLES,
  CONN_WARN_RATIO,
};
