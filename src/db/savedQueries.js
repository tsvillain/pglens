/**
 * Saved Queries store (roadmap §5.5).
 *
 * A saved query bundles raw SQL plus organizational metadata (name, folder,
 * tags, description) and a set of Postman-style `{{variable}}` default values.
 * Scoped per connection: a saved query belongs to exactly one `connectionId`
 * and its name is unique within that connection.
 *
 * Persisted to `~/.pglens/saved-queries.json` as `{ savedQueries: [...] }`,
 * written atomically (tmp file + rename) so a crash mid-write can't leave a
 * half-flushed JSON blob in place. Mirrors the saved-views store
 * (`src/db/views.js`).
 *
 * The SQL itself is stored verbatim and never executed here — it runs through
 * the normal `/api/query` path (parameterized, server-side) when loaded into
 * the editor, so persisting it carries no execution risk. `{{variable}}` values
 * are template substitutions resolved client-side at load time, kept distinct
 * from the `:name` bound parameters of `/api/query` (roadmap §5.2).
 */

const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');

const logger = require('../log');
const { SAVED_QUERIES_FILE, ensureLayout } = require('../config/paths');

const MAX_NAME_LEN = 120;
const MAX_SQL_LEN = 100_000;
const MAX_SAVED = 2000;

// `{{variable}}` default values: a flat name → string map. Names are validated
// loosely (the client scanner only surfaces identifier-shaped `{{name}}`), but
// we cap sizes so a saved query can't balloon the on-disk file.
const VariablesSchema = z.record(z.string().min(1).max(120), z.string().max(10_000));

const SavedQueryBodySchema = z.object({
  connectionId: z.string().min(1).max(255),
  name: z.string().min(1).max(MAX_NAME_LEN),
  sql: z.string().min(1).max(MAX_SQL_LEN),
  description: z.string().max(2000).nullable().optional(),
  folder: z.string().max(255).nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
  variables: VariablesSchema.nullable().optional(),
});

const SavedQueryPatchSchema = SavedQueryBodySchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'patch must change at least one field' },
);

// Import payloads omit `connectionId` (it's supplied by the target connection)
// and any server-assigned envelope fields (id/timestamps are re-minted).
const ImportItemSchema = SavedQueryBodySchema.omit({ connectionId: true });

let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function writeAtomic(payload) {
  ensureLayout();
  const tmp = `${SAVED_QUERIES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SAVED_QUERIES_FILE);
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVED_QUERIES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.savedQueries)) {
      logger.warn({ file: SAVED_QUERIES_FILE }, 'saved-queries.json malformed — starting empty');
      cache = { savedQueries: [] };
    } else {
      cache = { savedQueries: parsed.savedQueries };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err: err.message }, 'saved-queries.json read failed — starting empty');
    }
    cache = { savedQueries: [] };
  }
  return cache;
}

function persist() {
  writeAtomic(cache);
}

function normalize(parsed, { id, createdAt } = {}) {
  return {
    id: id ?? crypto.randomUUID(),
    connectionId: parsed.connectionId,
    name: parsed.name,
    sql: parsed.sql,
    description: parsed.description ?? null,
    folder: parsed.folder ?? null,
    tags: parsed.tags ?? [],
    variables: parsed.variables ?? null,
    createdAt: createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
}

function listSavedQueries({ connectionId } = {}) {
  const all = load().savedQueries;
  return all.filter((q) => !connectionId || q.connectionId === connectionId);
}

function getSavedQuery(id) {
  return load().savedQueries.find((q) => q.id === id) || null;
}

function createSavedQuery(body) {
  const parsed = SavedQueryBodySchema.parse(body);
  const all = load().savedQueries;
  if (all.length >= MAX_SAVED) {
    throw new Error(`Too many saved queries (limit ${MAX_SAVED})`);
  }
  const dup = all.find(
    (q) => q.connectionId === parsed.connectionId && q.name === parsed.name,
  );
  if (dup) {
    throw new Error(`A saved query named "${parsed.name}" already exists for this connection`);
  }
  const query = normalize(parsed);
  all.push(query);
  persist();
  return query;
}

function updateSavedQuery(id, patch) {
  const parsed = SavedQueryPatchSchema.parse(patch);
  const all = load().savedQueries;
  const idx = all.findIndex((q) => q.id === id);
  if (idx < 0) return null;
  const cur = all[idx];

  // Name uniqueness per connection. Allow renaming, but block a rename onto an
  // existing sibling's name within the same connection.
  if (parsed.name && parsed.name !== cur.name) {
    const targetConn = parsed.connectionId ?? cur.connectionId;
    const dup = all.find(
      (q) => q.id !== id && q.connectionId === targetConn && q.name === parsed.name,
    );
    if (dup) {
      throw new Error(`A saved query named "${parsed.name}" already exists for this connection`);
    }
  }

  const next = { ...cur, ...parsed, id: cur.id, createdAt: cur.createdAt, updatedAt: nowIso() };
  all[idx] = next;
  persist();
  return next;
}

function deleteSavedQuery(id) {
  const all = load().savedQueries;
  const idx = all.findIndex((q) => q.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  persist();
  return true;
}

/**
 * Bulk import for a target connection (roadmap §5.5 export/import). Each item is
 * validated, the connection is forced to `connectionId`, and a name colliding
 * with an existing sibling is auto-suffixed (`"name (2)"`, `"(3)"`, …) so an
 * import never overwrites or rejects on conflict. Returns the created records.
 */
function importMany(connectionId, items) {
  z.string().min(1).max(255).parse(connectionId);
  const all = load().savedQueries;
  if (all.length + items.length > MAX_SAVED) {
    throw new Error(`Import would exceed the saved-query limit (${MAX_SAVED})`);
  }
  const created = [];
  for (const raw of items) {
    const parsed = ImportItemSchema.parse(raw);
    let name = parsed.name;
    let n = 2;
    // Check against both existing records and ones created earlier this import.
    while (all.some((q) => q.connectionId === connectionId && q.name === name)) {
      name = `${parsed.name} (${n})`;
      n += 1;
    }
    const query = normalize({ ...parsed, connectionId, name });
    all.push(query);
    created.push(query);
  }
  if (created.length) persist();
  return created;
}

/** Test-only — wipe the in-memory cache so a fresh fs read happens next call. */
function _resetForTests() {
  cache = null;
}

module.exports = {
  listSavedQueries,
  getSavedQuery,
  createSavedQuery,
  updateSavedQuery,
  deleteSavedQuery,
  importMany,
  SavedQueryBodySchema,
  SavedQueryPatchSchema,
  ImportItemSchema,
  _resetForTests,
};
