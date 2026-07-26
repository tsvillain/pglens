/**
 * Auth provider extension point.
 *
 * Core ships one provider: the per-install token middleware from `../auth`.
 * A different auth strategy (e.g. OAuth-based sign-in) can be swapped in at
 * startup by calling `setAuthProvider()` before `startServer()` runs —
 * without this module ever depending on whatever provides it.
 *
 * A provider is `{ name, middleware(req, res, next) }`.
 */

const { tokenMiddleware } = require('../auth');

const localProvider = { name: 'local-token', middleware: tokenMiddleware };

let current = localProvider;

function setAuthProvider(provider) {
  if (!provider || typeof provider.middleware !== 'function') {
    throw new Error('auth provider must implement middleware(req, res, next)');
  }
  current = provider;
}

function getAuthProvider() {
  return current;
}

/** Test-only — restore the default local provider. */
function _resetForTests() {
  current = localProvider;
}

module.exports = { setAuthProvider, getAuthProvider, _resetForTests };
