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
