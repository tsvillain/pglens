/**
 * Standard error envelope.
 *
 * Responses use the shape:
 *   { error: { code, message, hint? } }
 *
 * The legacy vanilla client expects `error` to be a string. To stay
 * compatible during the strangler-fig migration, we also include a
 * top-level `errorMessage` mirror; v3 reads the structured field, v2 can
 * fall back to the mirror. Once `client/` is deleted (Phase 0 DoD),
 * the mirror goes too.
 */

function sendError(res, status, code, message, extra = {}) {
  const envelope = {
    error: {
      code,
      message,
      ...(extra.hint ? { hint: extra.hint } : {}),
    },
    errorMessage: message,
  };
  return res.status(status).json(envelope);
}

const codes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  NO_CONNECTION: 'NO_CONNECTION',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
  DB_ERROR: 'DB_ERROR',
  VALIDATION: 'VALIDATION',
};

module.exports = { sendError, codes };
