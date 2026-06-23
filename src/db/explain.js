/**
 * EXPLAIN ANALYZE timing extraction for the query result timing breakdown
 * (roadmap §5.4: "Query timing breakdown: parse, plan, execute").
 *
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <sql>` returns a single row whose
 * `QUERY PLAN` column is a JSON document carrying `Planning Time` and
 * `Execution Time` (milliseconds) alongside the plan tree. Postgres does not
 * separately report a "parse" time, so we surface the two it does give plus the
 * raw plan for the (future §6.3) visualizer; the client shows total wall-clock
 * as the third figure.
 */

/**
 * Pull `{ planningMs, executionMs, plan }` out of the rows returned by an
 * `EXPLAIN (... FORMAT JSON)` run. Tolerates the value arriving either as a
 * parsed object (porsager parses json columns) or as a JSON string, and missing
 * fields degrade to null rather than throwing.
 */
function extractExplainTiming(planRows) {
  let raw = planRows && planRows[0] ? planRows[0]['QUERY PLAN'] : null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const root = Array.isArray(raw) ? raw[0] : raw;
  if (!root || typeof root !== 'object') {
    return { planningMs: null, executionMs: null, plan: null };
  }
  return {
    planningMs: typeof root['Planning Time'] === 'number' ? root['Planning Time'] : null,
    executionMs: typeof root['Execution Time'] === 'number' ? root['Execution Time'] : null,
    plan: root,
  };
}

module.exports = { extractExplainTiming };
