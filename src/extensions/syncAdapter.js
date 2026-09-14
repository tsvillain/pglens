/**
 * Remote-sync adapter extension point.
 *
 * Fired after every local write to connections/views/saved queries. The
 * default adapter is a no-op — nothing leaves the machine unless something
 * calls `setSyncAdapter()` with an adapter that mirrors the record
 * elsewhere.
 *
 * `notify` is fire-and-forget by design: a slow or broken remote must never
 * block or fail the local write it's mirroring. Errors are swallowed here,
 * not by callers.
 *
 * An adapter is `{ name, notify(kind, record) }` where kind is one of
 * 'connection' | 'view' | 'savedQuery'.
 */

const logger = require('../log');

const noopAdapter = { name: 'none', notify: () => {} };

let current = noopAdapter;

function setSyncAdapter(adapter) {
  if (!adapter || typeof adapter.notify !== 'function') {
    throw new Error('sync adapter must implement notify(kind, record)');
  }
  current = adapter;
}

function getSyncAdapter() {
  return current;
}

/** Callers use this instead of calling adapter.notify directly. */
function notify(kind, record) {
  try {
    Promise.resolve(current.notify(kind, record)).catch((err) => {
      logger.warn({ err: err.message, kind, adapter: current.name }, 'sync notify failed');
    });
  } catch (err) {
    logger.warn({ err: err.message, kind, adapter: current.name }, 'sync notify threw');
  }
}

/** Test-only — restore the default no-op adapter. */
function _resetForTests() {
  current = noopAdapter;
}

module.exports = { setSyncAdapter, getSyncAdapter, notify, _resetForTests };
