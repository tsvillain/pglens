/**
 * Index assistant — Postgres-native operations (roadmap §6.4).
 *
 * Read-only advice derived entirely from the server's own catalogs/stat views,
 * surfaced in the "Index assistant" panel:
 *
 *   - Unused indexes      → pg_stat_user_indexes where idx_scan = 0
 *   - Duplicate indexes   → pg_index grouped by (table, columns, opclass,
 *                           collation, expr, predicate, access method)
 *   - Heavy seq scans     → pg_stat_user_tables (missing-index candidates)
 *
 * Like src/db/operations.js, every function takes the wrapped pool from
 * `requireConnection` (req.pool) and runs parameterized queries against system
 * views — no caller-supplied SQL ever reaches the server. The only generated
 * SQL is the DROP DDL attached to each removable index, built through the same
 * identifier escaper the rest of the app uses; it is shown for review and run
 * by the user in the editor, never executed by this module.
 *
 * ponytail: the "suggest CREATE INDEX (status, created_at) for this filter"
 * recommender from the roadmap needs hypopg or query-plan parsing to pick the
 * columns — skipped. The seq-scan section is the catalog-only proxy: it flags
 * which tables lean on sequential scans; the user picks the columns. Add the
 * column recommender when hypopg integration lands. Bloat (pgstattuple) is also
 * skipped — pgstattuple scans the whole relation, too costly for an interactive
 * panel; add it behind an explicit per-table "analyze bloat" action.
 */

const { quoteQualifiedIdent } = require('./identifier');

// Top-N per section, so a database with thousands of indexes/tables can't blow
// up the payload. Generous enough that real advisories are never truncated.
const TOP = 50;

// Tables below this live-row estimate are excluded from the seq-scan section:
// a sequential scan of a small table is the planner's correct choice, and an
// index there is noise, not a fix.
const SEQ_SCAN_MIN_ROWS = 10_000;

/** DROP DDL for one index, with both identifiers properly quoted. */
function buildDropIndexDdl(schema, indexName) {
  return `DROP INDEX ${quoteQualifiedIdent(schema, indexName)};`;
}

/**
 * Indexes never used since the stats were last reset (idx_scan = 0). Primary
 * keys, unique, and exclusion-constraint indexes are excluded — dropping them
 * would change semantics, not just reclaim space — as are invalid/half-built
 * indexes. Largest first, so the biggest reclaimable space is on top.
 */
async function getUnusedIndexes(pool, schema) {
  const { rows } = await pool.query(
    `SELECT s.relname        AS table_name,
            s.indexrelname   AS index_name,
            s.idx_scan::text AS idx_scan,
            pg_relation_size(s.indexrelid)                 AS size_bytes,
            pg_size_pretty(pg_relation_size(s.indexrelid)) AS size_pretty,
            pg_get_indexdef(s.indexrelid)                  AS indexdef
       FROM pg_stat_user_indexes s
       JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE s.schemaname = $1
        AND s.idx_scan = 0
        AND i.indisvalid
        AND NOT i.indisprimary
        AND NOT i.indisunique
        AND NOT i.indisexclusion
      ORDER BY pg_relation_size(s.indexrelid) DESC
      LIMIT $2`,
    [schema, TOP],
  );
  return rows.map((r) => ({ ...r, drop_ddl: buildDropIndexDdl(schema, r.index_name) }));
}

/**
 * Groups of exactly-redundant indexes: same table, same column list, opclasses,
 * collations, expression, predicate, and access method. Each group is two or
 * more indexes that do the same job — keep one, drop the rest. Each index in a
 * group carries its own DROP DDL so the user can choose which to remove.
 *
 * "Exact" is deliberate: a prefix-redundant index (one on (a) covered by
 * another on (a, b)) is *not* flagged here — that needs prefix matching and is
 * a softer call. Add it when the simple exact match proves insufficient.
 */
async function getDuplicateIndexes(pool, schema) {
  const { rows } = await pool.query(
    `WITH idx AS (
       SELECT i.indrelid,
              ct.relname AS table_name,
              ci.relname AS index_name,
              am.amname,
              i.indkey::text       AS k_cols,
              i.indclass::text     AS k_class,
              i.indcollation::text AS k_coll,
              COALESCE(pg_get_expr(i.indexprs, i.indrelid), '') AS k_expr,
              COALESCE(pg_get_expr(i.indpred,  i.indrelid), '') AS k_pred,
              pg_relation_size(i.indexrelid)                 AS size_bytes,
              pg_size_pretty(pg_relation_size(i.indexrelid)) AS size_pretty,
              pg_get_indexdef(i.indexrelid)                  AS indexdef,
              s.idx_scan
         FROM pg_index i
         JOIN pg_class ci    ON ci.oid = i.indexrelid
         JOIN pg_class ct    ON ct.oid = i.indrelid
         JOIN pg_namespace n ON n.oid  = ct.relnamespace
         JOIN pg_am am       ON am.oid = ci.relam
         LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
        WHERE n.nspname = $1
          AND i.indisvalid
          AND ct.relkind IN ('r', 'p', 'm')
     )
     SELECT table_name,
            json_agg(json_build_object(
              'index_name', index_name,
              'indexdef',   indexdef,
              'size_bytes', size_bytes,
              'size_pretty', size_pretty,
              'idx_scan',   idx_scan::text
            ) ORDER BY size_bytes DESC, index_name) AS indexes
       FROM idx
      GROUP BY indrelid, table_name, amname, k_cols, k_class, k_coll, k_expr, k_pred
     HAVING count(*) > 1
      ORDER BY table_name
      LIMIT $2`,
    [schema, TOP],
  );
  return rows.map((g) => ({
    table_name: g.table_name,
    indexes: (g.indexes || []).map((ix) => ({
      ...ix,
      drop_ddl: buildDropIndexDdl(schema, ix.index_name),
    })),
  }));
}

/**
 * Tables leaning on sequential scans (roadmap §6.4 missing-index proxy): more
 * seq scans than index scans, on a table large enough that an index would help.
 * Worst total rows read by seq scans first. No CREATE DDL is generated — the
 * right columns depend on the query, which the catalogs don't record (see the
 * module note on hypopg).
 */
async function getSeqScanTables(pool, schema) {
  const { rows } = await pool.query(
    `SELECT relname                           AS table_name,
            seq_scan::text                    AS seq_scan,
            seq_tup_read::text                AS seq_tup_read,
            COALESCE(idx_scan, 0)::text       AS idx_scan,
            n_live_tup::text                  AS n_live_tup,
            pg_relation_size(relid)                 AS size_bytes,
            pg_size_pretty(pg_relation_size(relid)) AS size_pretty
       FROM pg_stat_user_tables
      WHERE schemaname = $1
        AND seq_scan > 0
        AND n_live_tup >= $2
        AND seq_scan > COALESCE(idx_scan, 0)
      ORDER BY seq_tup_read DESC
      LIMIT $3`,
    [schema, SEQ_SCAN_MIN_ROWS, TOP],
  );
  return rows;
}

/**
 * Assemble all three sections in one round trip. Readers run in parallel and
 * each is isolated: a section that throws (e.g. a role without stat visibility)
 * comes back as `{ data: null, error }` so the rest of the panel renders —
 * mirrors operations.getOverview().
 */
async function getAdvice(pool, schema) {
  const readers = {
    unused: () => getUnusedIndexes(pool, schema),
    duplicate: () => getDuplicateIndexes(pool, schema),
    seqScans: () => getSeqScanTables(pool, schema),
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

module.exports = {
  getAdvice,
  getUnusedIndexes,
  getDuplicateIndexes,
  getSeqScanTables,
  buildDropIndexDdl,
  TOP,
  SEQ_SCAN_MIN_ROWS,
};
