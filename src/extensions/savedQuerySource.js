/**
 * Saved-query-source adapter extension point — same shape as
 * connectionSource.js / viewSource.js.
 *
 * Core lists saved queries from the local `saved-queries.json` only.
 * Additional sources can register here at startup — e.g. queries shared by
 * a team — and the saved-queries list merges their records in alongside
 * local ones. Nothing is registered by default, so behavior is unchanged
 * out of the box.
 *
 * A source is `{ name, listExternal(): Promise<SavedQueryRecord[]> }`.
 */

const logger = require('../log');

const sources = [];

function registerSavedQuerySource(source) {
  if (!source || typeof source.listExternal !== 'function') {
    throw new Error('saved query source must implement listExternal()');
  }
  sources.push(source);
}

async function listExternalSavedQueries() {
  const lists = await Promise.all(
    sources.map((s) =>
      Promise.resolve(s.listExternal()).catch((err) => {
        logger.warn({ err: err.message, source: s.name }, 'saved query source list failed');
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

module.exports = { registerSavedQuerySource, listExternalSavedQueries, _resetForTests };
