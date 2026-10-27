/**
 * Standard error envelope.
 *
 * Responses use the shape:
 *   { error: { code, message, hint? } }
 */

function sendError(res, status, code, message, extra = {}) {
  const envelope = {
    error: {
      code,
      message,
      ...(extra.hint ? { hint: extra.hint } : {}),
    },
  };
  return res.status(status).json(envelope);
}

const codes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  NO_CONNECTION: 'NO_CONNECTION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
  DB_ERROR: 'DB_ERROR',
  VALIDATION: 'VALIDATION',
};

module.exports = { sendError, codes };
