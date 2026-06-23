/**
 * Visual sort spec → ORDER BY clause.
 *
 * The UI sends a structured array of `{column, direction}` entries (priority
 * is array order). We validate every column against the table's metadata and
 * the direction against an allowlist, then emit a safely-quoted identifier
 * list. No user-supplied string ever lands in SQL without going through
 * `quoteIdent` + a direction whitelist.
 *
 * Spec shape:
 *   SortSpec = Array<{ column: string, direction: 'asc' | 'desc' }>
 */

const { z } = require('zod');
const { quoteIdent } = require('./identifier');

const MAX_SORTS = 10;

const SortEntrySchema = z.object({
  column: z.string().min(1).max(255).refine((s) => !s.includes('\0'), 'null byte'),
  direction: z.enum(['asc', 'desc', 'ASC', 'DESC']),
});

const SortSpecSchema = z.array(SortEntrySchema).max(MAX_SORTS);

/**
 * @param {unknown} spec
 * @param {object} columnMetadata  shape from getTableMetadata().columns
 * @param {string|null} primaryKeyColumn  appended as final tie-break when not
 *   already part of the user sort
 * @returns {{ sql: string, columns: string[] }}  sql is empty when there's no
 *   user sort and no PK to fall back on; callers should not prepend "ORDER BY"
 *   in that case. `columns` is the resolved sort columns in priority order
 *   (useful for legacy single-column callers).
 */
function buildOrderBy(spec, columnMetadata, primaryKeyColumn = null) {
  const entries = normalize(spec, columnMetadata);

  const parts = entries.map(
    (e) => `${quoteIdent(e.column)} ${e.direction.toUpperCase()}`,
  );

  if (primaryKeyColumn && !entries.some((e) => e.column === primaryKeyColumn)) {
    parts.push(`${quoteIdent(primaryKeyColumn)} ASC`);
  }

  if (parts.length === 0) return { sql: '', columns: [] };
  return {
    sql: ` ORDER BY ${parts.join(', ')}`,
    columns: entries.map((e) => e.column),
  };
}

function normalize(spec, columnMetadata) {
  if (spec == null) return [];
  const parsed = SortSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(`Invalid sort spec: ${parsed.error.issues[0]?.message ?? 'parse error'}`);
  }
  const seen = new Set();
  const out = [];
  for (const entry of parsed.data) {
    if (!columnMetadata[entry.column]) {
      throw new Error(`Unknown sort column: ${entry.column}`);
    }
    // Dedup — a column appearing twice would emit redundant SQL; keep first
    // occurrence so priority order is preserved.
    if (seen.has(entry.column)) continue;
    seen.add(entry.column);
    out.push(entry);
  }
  return out;
}

module.exports = { buildOrderBy, SortSpecSchema, MAX_SORTS };
