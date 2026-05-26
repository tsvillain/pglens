/**
 * Saved Views store.
 *
 * A "view" bundles (filter + sort + visible columns + column widths +
 * timezone) for a single (connectionId, tableName) pair. Persisted to
 * `~/.pglens/views.json` as a flat array of records and written atomically
 * (tmp file + rename) so a crash mid-write can't leave a half-flushed JSON
 * blob in place.
 *
 * The store is intentionally schema-aware about the *envelope* (id, name,
 * connection, table, timestamps) but treats the filter/sort payloads as
 * opaque blobs — they're re-validated against the live column metadata in
 * `buildWhere` / `buildOrderBy` on each request, so persisting a stale spec
 * fails closed at read time instead of failing here.
 */

const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');

const logger = require('../log');
const { VIEWS_FILE, ensureLayout } = require('../config/paths');

const MAX_NAME_LEN = 120;
const MAX_VIEWS = 1000;

// Filter/sort payloads are validated structurally here, then re-validated
// against the live column metadata inside buildWhere/buildOrderBy when the
// view is actually loaded. The shapes mirror src/db/filter.js + src/db/sort.js.
const FilterConditionSchema = z.object({
  type: z.literal('condition'),
  column: z.string().min(1).max(255),
  op: z.string().min(1).max(40),
  value: z.unknown().optional(),
});
const FilterGroupSchema = z.lazy(() =>
  z.object({
    type: z.literal('group'),
    combinator: z.enum(['and', 'or']),
    children: z.array(z.union([FilterConditionSchema, FilterGroupSchema])),
  }),
);
const SortEntrySchema = z.object({
  column: z.string().min(1).max(255),
  direction: z.enum(['asc', 'desc', 'ASC', 'DESC']),
});

const ViewBodySchema = z.object({
  connectionId: z.string().min(1).max(255),
  tableName: z.string().min(1).max(255),
  name: z.string().min(1).max(MAX_NAME_LEN),
  filter: FilterGroupSchema.nullable().optional(),
  sort: z.array(SortEntrySchema).max(50).optional(),
  visibleColumns: z.array(z.string().max(255)).max(500).nullable().optional(),
  columnWidths: z.record(z.string(), z.number().int().positive().max(4000))
    .nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
});

const ViewPatchSchema = ViewBodySchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'patch must change at least one field' },
);

// In-memory mirror of the JSON file. `null` until first load.
let cache = null;

function nowIso() {
  return new Date().toISOString();
}

/**
 * Atomic write: serialize → write to a sibling tmp path → rename onto the
 * real path. Rename is atomic on the same filesystem; a crash mid-write
 * leaves the previous version intact rather than a truncated JSON file.
 */
function writeAtomic(payload) {
  ensureLayout();
  const tmp = `${VIEWS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, VIEWS_FILE);
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(VIEWS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.views)) {
      logger.warn({ file: VIEWS_FILE }, 'views.json malformed — starting empty');
      cache = { views: [] };
    } else {
      cache = { views: parsed.views };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err: err.message }, 'views.json read failed — starting empty');
    }
    cache = { views: [] };
  }
  return cache;
}

function persist() {
  writeAtomic(cache);
}

function listViews({ connectionId, tableName } = {}) {
  const all = load().views;
  return all.filter(
    (v) =>
      (!connectionId || v.connectionId === connectionId) &&
      (!tableName || v.tableName === tableName),
  );
}

function getView(id) {
  return load().views.find((v) => v.id === id) || null;
}

function createView(body) {
  const parsed = ViewBodySchema.parse(body);
  const all = load().views;
  if (all.length >= MAX_VIEWS) {
    throw new Error(`Too many saved views (limit ${MAX_VIEWS})`);
  }
  const dup = all.find(
    (v) =>
      v.connectionId === parsed.connectionId &&
      v.tableName === parsed.tableName &&
      v.name === parsed.name,
  );
  if (dup) {
    throw new Error(`A view named "${parsed.name}" already exists for this table`);
  }
  const view = {
    id: crypto.randomUUID(),
    connectionId: parsed.connectionId,
    tableName: parsed.tableName,
    name: parsed.name,
    filter: parsed.filter ?? null,
    sort: parsed.sort ?? [],
    visibleColumns: parsed.visibleColumns ?? null,
    columnWidths: parsed.columnWidths ?? null,
    timezone: parsed.timezone ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  all.push(view);
  persist();
  return view;
}

function updateView(id, patch) {
  const parsed = ViewPatchSchema.parse(patch);
  const all = load().views;
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return null;
  const cur = all[idx];

  // Name uniqueness per (connection, table). Allow renaming, but block a
  // rename onto an existing sibling's name.
  if (parsed.name && parsed.name !== cur.name) {
    const targetConn = parsed.connectionId ?? cur.connectionId;
    const targetTable = parsed.tableName ?? cur.tableName;
    const dup = all.find(
      (v) =>
        v.id !== id &&
        v.connectionId === targetConn &&
        v.tableName === targetTable &&
        v.name === parsed.name,
    );
    if (dup) {
      throw new Error(`A view named "${parsed.name}" already exists for this table`);
    }
  }

  const next = { ...cur, ...parsed, id: cur.id, createdAt: cur.createdAt, updatedAt: nowIso() };
  all[idx] = next;
  persist();
  return next;
}

function deleteView(id) {
  const all = load().views;
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  persist();
  return true;
}

/** Test-only — wipe the in-memory cache so a fresh fs read happens next call. */
function _resetForTests() {
  cache = null;
}

module.exports = {
  listViews,
  getView,
  createView,
  updateView,
  deleteView,
  ViewBodySchema,
  ViewPatchSchema,
  _resetForTests,
};
