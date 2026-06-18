/**
 * Slow query view — Postgres-native operations (roadmap §6.2).
 *
 * Surfaces the server's own `pg_stat_statements` aggregates so a user can find
 * the queries that cost the most cumulative time and drill into one for its
 * timing spread and IO. Read-only except for the two explicit actions:
 *
 *   - enable → CREATE EXTENSION IF NOT EXISTS pg_stat_statements
 *   - reset  → pg_stat_statements_reset()
 *
 * Like src/db/operations.js, every function takes the wrapped pool from
 * `requireConnection` (req.pool) and runs parameterized queries against system
 * views — no caller-supplied SQL ever reaches the server. The one column the
 * caller influences is the ORDER BY, which is mapped through SORT_COLUMNS
 * server-side (a fixed allowlist), never interpolated from raw input.
 *
 * Requires PostgreSQL 13+: the `*_exec_time` columns were renamed from the old
 * `*_time` columns in pg_stat_statements 1.8 (PG13). Older servers surface the
 * raw "column does not exist" error to the client.
 */

// CREATE EXTENSION is offered as a one-click action (roadmap §6.2: "show a
// one-click 'Enable pg_stat_statements' with the DDL preview"). The same string
// is shown to the user as the preview and run by the enable action.
const ENABLE_DDL = 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;';

// Allowlist of sortable metrics → the real column (roadmap §6.2: "Top queries
// by total_exec_time, mean_exec_time, calls"). The ORDER BY is chosen from this
// map only, so a bad/spoofed sort key can never reach the SQL.
const SORT_COLUMNS = {
  total_exec_time: 'total_exec_time',
  mean_exec_time: 'mean_exec_time',
  calls: 'calls',
};
const DEFAULT_SORT = 'total_exec_time';

// Default / max rows returned. The view itself is capped by the server's
// pg_stat_statements.max (default 5000); this just bounds the payload.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// One-sided 95th-percentile z-score of the standard normal. pg_stat_statements
// stores only mean/stddev/min/max — not percentiles — so p95 is *estimated*
// (see estimateP95). Kept in one place so the UI's "p95 (est.)" label and this
// math never drift.
const P95_Z = 1.6449;

/**
 * Estimate a query's 95th-percentile execution time from the only spread
 * pg_stat_statements records: mean and stddev. Models the distribution as
 * normal — p95 ≈ mean + 1.6449·stddev — then clamps to [mean, max] so the
 * estimate never dips below the mean or exceeds the observed maximum. Pure, so
 * the approximation lives in exactly one tested place. Returns null when the
 * mean is unknown.
 */
function estimateP95(mean, stddev, max) {
  if (mean == null) return null;
  const m = Number(mean);
  if (!Number.isFinite(m)) return null;
  const sd = Number(stddev);
  const est = Number.isFinite(sd) ? m + P95_Z * sd : m;
  const floored = Math.max(est, m);
  const cap = Number(max);
  return Number.isFinite(cap) ? Math.min(floored, cap) : floored;
}

/** Map a (possibly untrusted) sort key to a real column, defaulting safely. */
function sortColumn(key) {
  return SORT_COLUMNS[key] ?? SORT_COLUMNS[DEFAULT_SORT];
}

/** Clamp the requested row limit into [1, MAX_LIMIT], defaulting when unset. */
function rowLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Whether pg_stat_statements is created in this database (`installed`) and, if
 * not, whether it is available to install from the server's contrib packages
 * (`available`). Drives the "enable" prompt vs. the table.
 */
async function checkStatus(pool) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM pg_extension          WHERE extname = 'pg_stat_statements') AS installed,
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS available`,
    [],
  );
  const row = rows[0] ?? {};
  return { installed: row.installed === true, available: row.available === true };
}

/**
 * Top statements for the current database ordered by the chosen metric. bigint
 * counters are cast to text so large values survive JSON without precision
 * loss; the float8 `*_exec_time` columns come back as numbers. Each row gets a
 * derived `p95_exec_time_est` (see estimateP95).
 */
async function topStatements(pool, sort, limit) {
  const col = sortColumn(sort);
  const { rows } = await pool.query(
    `SELECT queryid::text                  AS queryid,
            query,
            calls::text                    AS calls,
            total_exec_time,
            mean_exec_time,
            stddev_exec_time,
            min_exec_time,
            max_exec_time,
            rows::text                     AS rows,
            shared_blks_hit::text          AS shared_blks_hit,
            shared_blks_read::text         AS shared_blks_read,
            shared_blks_dirtied::text      AS shared_blks_dirtied,
            shared_blks_written::text      AS shared_blks_written,
            local_blks_hit::text           AS local_blks_hit,
            local_blks_read::text          AS local_blks_read,
            temp_blks_read::text           AS temp_blks_read,
            temp_blks_written::text        AS temp_blks_written
       FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY ${col} DESC NULLS LAST
      LIMIT $1`,
    [rowLimit(limit)],
  );
  return rows.map((r) => ({
    ...r,
    p95_exec_time_est: estimateP95(r.mean_exec_time, r.stddev_exec_time, r.max_exec_time),
  }));
}

/**
 * The slow-query payload as a small state machine so the client can render the
 * right surface without guessing from an error string:
 *
 *   not_installed → extension absent; offer the enable DDL (if `available`)
 *   not_loaded    → extension created but the library isn't in
 *                   shared_preload_libraries, so the view errors on read
 *   ready         → `statements` populated
 */
async function getStatements(pool, { sort, limit } = {}) {
  const status = await checkStatus(pool);
  if (!status.installed) {
    return { status: 'not_installed', available: status.available, ddl: ENABLE_DDL, statements: [] };
  }
  try {
    const statements = await topStatements(pool, sort, limit);
    return { status: 'ready', available: true, statements };
  } catch (err) {
    // The library must be preloaded; CREATE EXTENSION alone leaves the view
    // present but unreadable. Treat that as its own state, not a 500.
    if (/shared_preload_libraries/i.test(err.message)) {
      return { status: 'not_loaded', available: true, ddl: ENABLE_DDL, statements: [] };
    }
    throw err;
  }
}

/**
 * Create the extension (idempotent). Requires a privileged role; the route maps
 * a failure to a DB error the user can read. Returns the refreshed status so the
 * client can tell "created, collecting" from "created but needs preload".
 */
async function enableStatements(pool) {
  await pool.query(ENABLE_DDL.replace(/;$/, ''), []);
  const status = await checkStatus(pool);
  return { enabled: status.installed, ...status };
}

/**
 * Discard all collected statistics (roadmap §6.2: "Reset stats" button) via
 * pg_stat_statements_reset(). Requires a privileged role.
 */
async function resetStatements(pool) {
  await pool.query('SELECT pg_stat_statements_reset()', []);
  return { reset: true };
}

module.exports = {
  getStatements,
  enableStatements,
  resetStatements,
  checkStatus,
  estimateP95,
  sortColumn,
  rowLimit,
  SORT_COLUMNS,
  DEFAULT_SORT,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ENABLE_DDL,
  P95_Z,
};
