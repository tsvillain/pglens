/**
 * Build the SQL handed to the Query editor by the slow-query drilldown's
 * "Explain in editor" action (roadmap §6.2).
 *
 * pg_stat_statements stores *normalized* query text — every literal is replaced
 * by a placeholder (`$1`, `$2`, …). A plain `EXPLAIN` on that fails with
 * "there is no parameter $1", because the placeholders have no bound values.
 *
 * `EXPLAIN (GENERIC_PLAN)` (PostgreSQL 16+) is built for exactly this: it plans
 * a parameterized statement without any parameter values, treating the
 * placeholders as unknown. So the normalized text runs as-is. Statements with
 * no placeholders get a plain `EXPLAIN`.
 */
export function buildExplainSql(query: string): string {
  const sql = query.trim()
  if (!/\$\d+/.test(sql)) return `EXPLAIN\n${sql}`
  return (
    '-- pg_stat_statements normalized literals to $1, $2…; GENERIC_PLAN plans the\n' +
    '-- parameterized form without values (PostgreSQL 16+).\n' +
    `EXPLAIN (GENERIC_PLAN)\n${sql}`
  )
}

/**
 * Build the `EXPLAIN (… FORMAT JSON) <sql>` to run as a normal query and feed
 * to the §6.3 plan visualizer (the no-code "Explain plan" and slow-query
 * "Visualize plan" entry points). This is always a *plain* EXPLAIN — estimates
 * only, nothing executes — so it is safe to fire on any query without running
 * it. A statement still carrying `$n` placeholders (a pg_stat_statements
 * normalized query) uses `GENERIC_PLAN` so it can plan without bound values
 * (PostgreSQL 16+); everything else uses a straight `EXPLAIN (FORMAT JSON)`.
 */
export function buildExplainJsonSql(query: string): string {
  // Drop a trailing semicolon (and any space around it) so the prefix wraps cleanly.
  const sql = query.trim().replace(/\s*;\s*$/, '')
  const opts = /\$\d+/.test(sql) ? 'GENERIC_PLAN, FORMAT JSON' : 'FORMAT JSON'
  return `EXPLAIN (${opts}) ${sql}`
}
