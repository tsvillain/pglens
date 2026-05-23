/**
 * Postgres identifier escaping.
 *
 * Replaces the prior regex allowlist (`^[a-zA-Z0-9_]+$`), which rejected
 * perfectly valid mixed-case, accented, and quoted identifiers, with the
 * canonical double-quote escape: any non-null-byte string is allowed; any
 * embedded double quotes are doubled.
 */

function quoteIdent(name) {
  if (typeof name !== 'string') {
    throw new Error('Identifier must be a string');
  }
  if (name.length === 0) {
    throw new Error('Identifier must not be empty');
  }
  if (name.includes('\0')) {
    throw new Error('Identifier must not contain null bytes');
  }
  // Postgres truncates identifiers at 63 bytes by default (NAMEDATALEN-1).
  // Accept up to a slightly larger size in case the cluster was rebuilt with
  // a higher NAMEDATALEN; the server will still reject anything it can't use.
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new Error('Identifier exceeds maximum length');
  }
  return '"' + name.replaceAll('"', '""') + '"';
}

/**
 * Quote a possibly schema-qualified identifier ("schema.table"). Accepts a
 * single string only when the caller has not already split it.
 */
function quoteQualifiedIdent(schema, name) {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

module.exports = { quoteIdent, quoteQualifiedIdent };
