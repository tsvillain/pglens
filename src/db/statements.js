/**
 * SQL script splitting for Advanced-mode multi-statement results (roadmap §5.4).
 *
 * Postgres' extended query protocol — the one that carries bound parameters —
 * runs exactly one statement per round-trip. To return "multiple result tabs
 * from multi-statement queries" we split a script into its individual
 * statements here and execute each separately, yielding one result per tab.
 *
 * This is a lexical splitter, not a full parser. It walks the text tracking the
 * constructs in which a `;` is NOT a statement separator:
 *   - single-quoted strings    '...'         ('' escapes a quote)
 *   - escape strings           E'...\n'      (backslash escapes)
 *   - quoted identifiers       "..."         ("" escapes a quote)
 *   - dollar-quoted bodies     $tag$...$tag$ (function bodies, etc.)
 *   - line comments            -- ... \n
 *   - block comments           /* ... *​/    (nest in Postgres)
 * Everything else is statement text; a bare `;` ends a statement.
 *
 * Statements are returned trimmed, with the trailing `;` removed. Blank and
 * comment-only statements are dropped, so `SELECT 1;;`, a trailing `;`, and a
 * `-- note` line never produce empty results.
 */

/**
 * If `sql[i]` opens a dollar-quote (`$$` or `$tag$`), return the full tag
 * (e.g. `$$` or `$body$`); otherwise null. A tag follows identifier rules, so
 * `$1` (a positional parameter) is not a dollar-quote.
 */
function matchDollarTag(sql, i) {
  if (sql[i] !== '$') return null;
  if (sql[i + 1] === '$') return '$$';
  if (!/[A-Za-z_]/.test(sql[i + 1] || '')) return null;
  let j = i + 2;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  return sql[j] === '$' ? sql.slice(i, j + 1) : null;
}

/** True when `stmt` contains only whitespace and comments (no real tokens). */
function isCommentOnly(stmt) {
  let i = 0;
  const n = stmt.length;
  while (i < n) {
    const ch = stmt[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && stmt[i + 1] === '-') {
      const end = stmt.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '/' && stmt[i + 1] === '*') {
      const end = stmt.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    return false;
  }
  return true;
}

function pushStatement(out, raw) {
  const trimmed = raw.trim();
  if (trimmed && !isCommentOnly(trimmed)) out.push(trimmed);
}

/**
 * Split a SQL script into individual statements. Returns `[]` when the script
 * is empty or only whitespace/comments.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ (nestable in Postgres)
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    // $tag$ dollar-quoted body $tag$
    const tag = matchDollarTag(sql, i);
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const stop = close === -1 ? n : close + tag.length;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // '...' string. A leading standalone E/e enables backslash escapes.
    if (ch === "'") {
      const prev = buf[buf.length - 1] || '';
      const beforePrev = buf[buf.length - 2] || '';
      const isEscape = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_]/.test(beforePrev);
      let j = i + 1;
      while (j < n) {
        if (isEscape && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; } // '' escaped quote
          j += 1;
          break;
        }
        j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    // "..." quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; } // "" escaped quote
          j += 1;
          break;
        }
        j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }

    // ; statement terminator
    if (ch === ';') {
      pushStatement(out, buf);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  pushStatement(out, buf);
  return out;
}

module.exports = { splitStatements };
