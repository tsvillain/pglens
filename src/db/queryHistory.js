/**
 * Query History store (roadmap §5.5).
 *
 * Records each Advanced-mode query run, scoped per connection. Persisted to
 * `~/.pglens/query-history.json` as `{ entries: [...] }`, written atomically
 * (tmp file + rename). Append-only with a per-connection ring buffer: once a
 * connection accumulates more than `MAX_PER_CONNECTION` entries, the oldest are
 * dropped on the next add so the file can't grow without bound.
 *
 * Entries are ordered oldest-first on disk; `listHistory` returns them
 * most-recent-first. The raw SQL the user typed is stored verbatim (including
 * any `:name` / `{{variable}}` placeholders) so restoring an entry reproduces
 * the original editor text rather than a rewritten form.
 */

const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');

const logger = require('../log');
const { QUERY_HISTORY_FILE, ensureLayout } = require('../config/paths');

const MAX_PER_CONNECTION = 200;
const MAX_SQL_LEN = 100_000;

const HistoryEntrySchema = z.object({
  connectionId: z.string().min(1).max(255),
  sql: z.string().min(1).max(MAX_SQL_LEN),
  durationMs: z.number().int().nonnegative().max(86_400_000).nullable().optional(),
  rowCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  success: z.boolean(),
  error: z.string().max(2000).nullable().optional(),
});

let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function writeAtomic(payload) {
  ensureLayout();
  const tmp = `${QUERY_HISTORY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, QUERY_HISTORY_FILE);
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(QUERY_HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) {
      logger.warn({ file: QUERY_HISTORY_FILE }, 'query-history.json malformed — starting empty');
      cache = { entries: [] };
    } else {
      cache = { entries: parsed.entries };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err: err.message }, 'query-history.json read failed — starting empty');
    }
    cache = { entries: [] };
  }
  return cache;
}

function persist() {
  writeAtomic(cache);
}

/** Drop the oldest entries for `connectionId` beyond the per-connection cap. */
function trim(all, connectionId) {
  const count = all.reduce((n, e) => (e.connectionId === connectionId ? n + 1 : n), 0);
  let toRemove = count - MAX_PER_CONNECTION;
  if (toRemove <= 0) return;
  // Entries are oldest-first, so remove matching ones from the front.
  for (let i = 0; i < all.length && toRemove > 0; ) {
    if (all[i].connectionId === connectionId) {
      all.splice(i, 1);
      toRemove -= 1;
    } else {
      i += 1;
    }
  }
}

/**
 * Most-recent-first. `connectionId` is required by the route, but the store
 * tolerates its absence (returns everything) for symmetry with the views store.
 */
function listHistory({ connectionId, limit } = {}) {
  const all = load().entries;
  const filtered = connectionId
    ? all.filter((e) => e.connectionId === connectionId)
    : all.slice();
  filtered.reverse();
  return limit ? filtered.slice(0, limit) : filtered;
}

function addHistory(body) {
  const parsed = HistoryEntrySchema.parse(body);
  const all = load().entries;
  const entry = {
    id: crypto.randomUUID(),
    connectionId: parsed.connectionId,
    sql: parsed.sql,
    durationMs: parsed.durationMs ?? null,
    rowCount: parsed.rowCount ?? null,
    success: parsed.success,
    error: parsed.error ?? null,
    executedAt: nowIso(),
  };
  all.push(entry);
  trim(all, entry.connectionId);
  persist();
  return entry;
}

function deleteEntry(id) {
  const all = load().entries;
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  persist();
  return true;
}

/** Remove every entry for a connection. Returns the number removed. */
function clearHistory(connectionId) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.connectionId !== connectionId);
  const removed = before - data.entries.length;
  if (removed > 0) persist();
  return removed;
}

/** Test-only — wipe the in-memory cache so a fresh fs read happens next call. */
function _resetForTests() {
  cache = null;
}

module.exports = {
  listHistory,
  addHistory,
  deleteEntry,
  clearHistory,
  HistoryEntrySchema,
  MAX_PER_CONNECTION,
  _resetForTests,
};
