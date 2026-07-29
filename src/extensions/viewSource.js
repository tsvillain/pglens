/**
 * View-source adapter extension point — same shape as connectionSource.js.
 *
 * Core lists views from the local `views.json` only. Additional sources can
 * register here at startup — e.g. views shared by a team — and `listViews()`
 * (src/db/views.js) merges their records into the list alongside local ones.
 * Nothing is registered by default, so behavior is unchanged out of the box.
 *
 * A source is `{ name, listExternal(): Promise<ViewRecord[]> }`. `ViewRecord`
 * matches the shape `listViews()` already returns (id, connectionId,
 * tableName, name, filter, sort, visibleColumns, columnWidths, timezone).
 */

const logger = require('../log');

const sources = [];

function registerViewSource(source) {
  if (!source || typeof source.listExternal !== 'function') {
    throw new Error('view source must implement listExternal()');
  }
  sources.push(source);
}

async function listExternalViews() {
  const lists = await Promise.all(
    sources.map((s) =>
      Promise.resolve(s.listExternal()).catch((err) => {
        logger.warn({ err: err.message, source: s.name }, 'view source list failed');
        return [];
      }),
    ),
  );
  return lists.flat();
}

/** Test-only — drop all registered sources. */
function _resetForTests() {
  sources.length = 0;
}

module.exports = { registerViewSource, listExternalViews, _resetForTests };
