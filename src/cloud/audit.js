/**
 * Fire-and-forget audit reporting to pglens-cloud — metadata only (statement
 * kind + table name), never raw SQL or row data (COMMERCIALIZATION.md §6 /
 * the note on audit_log in pglens-cloud's db/schema.sql). No-ops with no
 * session or no selected workspace — same local-first degradation as every
 * other src/cloud/ module. Never awaited by callers: an audit report must
 * never slow down or fail the actual database operation it's describing.
 */

const logger = require('../log');
const session = require('./session');
const client = require('./client');

function reportEvent({ connectionId, statementKind, tableName }) {
  const workspaceId = session.getWorkspaceId();
  if (!workspaceId) return;

  client
    .request(`/workspaces/${workspaceId}/audit`, {
      method: 'POST',
      body: { connectionId, statementKind, tableName },
    })
    .catch((err) => {
      logger.warn({ err: err.message }, 'audit event report failed');
    });
}

/**
 * Best-effort statement classifier for raw SQL (Advanced mode) — a lexical
 * guess, not a parser (mirrors the ponytail note on src/db/statements.js).
 * Good enough for "looks like an UPDATE touching orders"; no-code mutations
 * report their kind/table directly since the caller already knows them
 * precisely, no guessing needed there.
 */
function classifyStatement(sqlText) {
  const trimmed = (sqlText || '').trimStart();
  const match = trimmed.match(/^(select|insert|update|delete|create|alter|drop)\b/i);
  if (!match) return { statementKind: 'other', tableName: null };
  const keyword = match[1].toLowerCase();
  const statementKind = ['create', 'alter', 'drop'].includes(keyword) ? 'ddl' : keyword;

  const tableMatch = trimmed.match(/\b(?:from|into|update|table)\s+"?([a-zA-Z_][\w.]*)"?/i);
  const tableName = tableMatch ? tableMatch[1].replace(/^public\./, '') : null;

  return { statementKind, tableName };
}

module.exports = { reportEvent, classifyStatement };
