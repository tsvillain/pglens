/**
 * Monaco SQL language support for the Advanced-mode editor (roadmap §5.2).
 *
 * Syntax highlighting comes from Monaco's built-in `sql` grammar. On top of it
 * we register a single, schema-aware completion provider: it suggests Postgres
 * keywords and functions, the connected schema's tables, and — after `table.`
 * or `alias.` — that table's columns.
 *
 * The provider is registered once per Monaco instance (it's a singleton shared
 * by every editor). The "active" schema is module-level state that the focused
 * SqlConsole keeps current via {@link setActiveSchema}.
 */

import type * as Monaco from 'monaco-editor'

import { formatSql, type SchemaTable } from '@/lib/api'

export type SchemaMap = Record<string, SchemaTable>

// Postgres reserved words + common non-reserved keywords worth completing.
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
  'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE',
  'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT',
  'WITH', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'ASC', 'DESC',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'TRUNCATE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'ANALYZE', 'COALESCE', 'CAST',
]

const FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'now', 'coalesce', 'nullif', 'greatest',
  'least', 'length', 'lower', 'upper', 'trim', 'substring', 'replace',
  'to_char', 'to_date', 'to_timestamp', 'date_trunc', 'extract', 'age',
  'array_agg', 'string_agg', 'json_agg', 'jsonb_agg', 'row_number', 'rank',
  'generate_series', 'unnest',
]

// Keywords after which the user is naming a relation — bias tables to the top.
const TABLE_CONTEXT = /\b(from|join|into|update|truncate|table)\s+("?\w*"?)?$/i

let activeSchema: SchemaMap | null = null
let registered = false

// Postgres folds unquoted identifiers to lowercase, so anything that isn't a
// plain lowercase word (e.g. "AppCommunityCode", "isGift") must be inserted
// double-quoted to resolve. The visible label stays bare for readability.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/
function quoteIfNeeded(name: string): string {
  return SAFE_IDENT.test(name) ? name : `"${name.replaceAll('"', '""')}"`
}

/** Set the schema the completion provider draws tables/columns from. */
export function setActiveSchema(schema: SchemaMap | null): void {
  activeSchema = schema
}

/** Map every `alias` and bare table reference in the SQL to its real table. */
function parseAliases(text: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\b(?:from|join|update|into)\s+"?(\w+)"?(?:\s+(?:as\s+)?"?(\w+)"?)?/gi
  let m: RegExpExecArray | null
  const noise = new Set(['where', 'on', 'set', 'join', 'inner', 'left', 'right', 'full', 'cross', 'using', 'group', 'order', 'limit'])
  while ((m = re.exec(text)) !== null) {
    const table = m[1]
    map.set(table.toLowerCase(), table)
    const alias = m[2]
    if (alias && !noise.has(alias.toLowerCase())) map.set(alias.toLowerCase(), table)
  }
  return map
}

/** Resolve a table by exact key, then case-insensitively. */
function lookupTable(schema: SchemaMap, name: string): SchemaTable | undefined {
  if (schema[name]) return schema[name]
  const lower = name.toLowerCase()
  for (const key of Object.keys(schema)) {
    if (key.toLowerCase() === lower) return schema[key]
  }
  return undefined
}

export function registerSqlSupport(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  // Format-on-save: routes through the server formatter (roadmap §5.2). Wiring
  // it as a document-formatting provider means Monaco's own format actions and
  // Cmd/Ctrl+S (bound in SqlConsole) both go through here.
  monaco.languages.registerDocumentFormattingEditProvider('sql', {
    async provideDocumentFormattingEdits(model) {
      try {
        const formatted = await formatSql(model.getValue())
        return [{ range: model.getFullModelRange(), text: formatted }]
      } catch {
        // Leave the buffer untouched if the server can't parse it.
        return []
      }
    },
  })

  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const schema = activeSchema
      const word = model.getWordUntilPosition(position)
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      const K = monaco.languages.CompletionItemKind

      // Text on this line up to (but excluding) the word being typed.
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: word.startColumn,
      })

      // `alias.` / `table.` → complete that table's columns only.
      const dotMatch = /(\w+)\.$/.exec(linePrefix)
      if (dotMatch && schema) {
        const aliases = parseAliases(model.getValue())
        const tableName = aliases.get(dotMatch[1].toLowerCase()) ?? dotMatch[1]
        const table = lookupTable(schema, tableName)
        if (table) {
          return {
            suggestions: table.columns.map((c) => ({
              label: c.name,
              kind: K.Field,
              detail: c.type,
              insertText: quoteIfNeeded(c.name),
              range,
            })),
          }
        }
        return { suggestions: [] }
      }

      const suggestions: Monaco.languages.CompletionItem[] = []
      const tablesFirst = TABLE_CONTEXT.test(linePrefix)

      if (schema) {
        for (const name of Object.keys(schema)) {
          suggestions.push({
            label: name,
            kind: K.Struct,
            detail: 'table',
            insertText: quoteIfNeeded(name),
            range,
            sortText: (tablesFirst ? '0' : '2') + name,
          })
        }
        if (!tablesFirst) {
          // Offer columns from the tables this query actually references (its
          // FROM/JOIN targets); fall back to every table only when none are
          // resolved yet, so a 25-table schema doesn't dump hundreds of names.
          const referenced = new Set(parseAliases(model.getValue()).values())
          const sources = referenced.size
            ? [...referenced]
                .map((t) => lookupTable(schema, t))
                .filter((t): t is SchemaTable => !!t)
            : Object.values(schema)
          // Columns of referenced tables rank above keywords; the all-tables
          // fallback ranks below them.
          const colRank = referenced.size ? '0' : '3'
          for (const table of sources) {
            for (const c of table.columns) {
              suggestions.push({
                label: c.name,
                kind: K.Field,
                detail: `${table.name}.${c.name} · ${c.type}`,
                insertText: quoteIfNeeded(c.name),
                range,
                sortText: colRank + c.name,
              })
            }
          }
        }
      }

      if (!tablesFirst) {
        for (const kw of KEYWORDS) {
          suggestions.push({
            label: kw,
            kind: K.Keyword,
            insertText: kw,
            range,
            sortText: '1' + kw,
          })
        }
        for (const fn of FUNCTIONS) {
          suggestions.push({
            label: fn,
            kind: K.Function,
            insertText: `${fn}($0)`,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: '4' + fn,
          })
        }
      }

      return { suggestions }
    },
  })
}
