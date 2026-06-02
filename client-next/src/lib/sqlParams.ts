/**
 * Named-parameter support for the Advanced-mode editor (roadmap §5.2).
 *
 * A query may use `:name` placeholders; we render a form for them below the
 * editor and, on run, rewrite each `:name` to a positional `$n` and ship a
 * params array so the server stays parameterized (never string-interpolated).
 *
 * The scanner deliberately ignores colons that are not placeholders:
 *   - `::type` casts                         (e.g. `id::int`)
 *   - array / range slices                   (e.g. `arr[lo:hi]`)
 *   - colons inside string/identifier quotes (e.g. `'12:00'`, `"a:b"`)
 *   - colons inside comments and dollar-quoted bodies
 */

const IDENT_START = /[A-Za-z_]/
const IDENT_CHAR = /[A-Za-z0-9_]/

interface ParamRef {
  name: string
  /** Inclusive start offset of the `:` in the source. */
  start: number
  /** Exclusive end offset (one past the last name char). */
  end: number
}

/**
 * Walk the SQL once, collecting every `:name` placeholder occurrence in source
 * order. Skips strings, quoted identifiers, comments, dollar-quoted bodies, and
 * `::` casts so those colons never look like parameters.
 */
function scan(sql: string): ParamRef[] {
  const refs: ParamRef[] = []
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const prev = i > 0 ? sql[i - 1] : ''

    // Line comment: -- … to end of line.
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      continue
    }

    // Block comment: /* … */, nestable in Postgres.
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      let depth = 1
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }

    // Single-quoted string literal ('' is an escaped quote).
    if (ch === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") {
          i++
          break
        } else i++
      }
      continue
    }

    // Double-quoted identifier ("" is an escaped quote).
    if (ch === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2
        else if (sql[i] === '"') {
          i++
          break
        } else i++
      }
      continue
    }

    // Dollar-quoted string: $tag$ … $tag$ (tag optional).
    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tagMatch) {
        const closer = tagMatch[0]
        const bodyStart = i + closer.length
        const closeAt = sql.indexOf(closer, bodyStart)
        i = closeAt === -1 ? n : closeAt + closer.length
        continue
      }
      // Not a dollar-quote (e.g. positional `$1`) — treat `$` literally.
      i++
      continue
    }

    // `::` cast — skip both colons so neither starts a placeholder.
    if (ch === ':' && sql[i + 1] === ':') {
      i += 2
      continue
    }

    // A placeholder starts only when the colon is not glued to a preceding
    // identifier/digit (which would make it a slice like arr[lo:hi]).
    if (ch === ':' && IDENT_START.test(sql[i + 1] ?? '') && !IDENT_CHAR.test(prev)) {
      let j = i + 1
      while (j < n && IDENT_CHAR.test(sql[j])) j++
      refs.push({ name: sql.slice(i + 1, j), start: i, end: j })
      i = j
      continue
    }

    i++
  }

  return refs
}

/** Distinct placeholder names in first-occurrence order. */
export function extractParamNames(sql: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const ref of scan(sql)) {
    if (!seen.has(ref.name)) {
      seen.add(ref.name)
      names.push(ref.name)
    }
  }
  return names
}

export interface ParameterizedQuery {
  /** SQL with every `:name` rewritten to a positional `$n`. */
  sql: string
  /** Values aligned to `$1..$n`, in the order names first appear. */
  params: unknown[]
}

/**
 * Rewrite `:name` placeholders to `$n` and collect their values from `values`,
 * in first-occurrence order. Repeated names reuse the same positional index.
 * Missing values map to SQL NULL.
 */
export function applyParams(
  sql: string,
  values: Record<string, unknown>,
): ParameterizedQuery {
  const refs = scan(sql)
  const order: string[] = []
  const indexOf = new Map<string, number>()
  for (const { name } of refs) {
    if (!indexOf.has(name)) {
      indexOf.set(name, order.length + 1)
      order.push(name)
    }
  }

  let out = ''
  let cursor = 0
  for (const ref of refs) {
    out += sql.slice(cursor, ref.start) + '$' + indexOf.get(ref.name)
    cursor = ref.end
  }
  out += sql.slice(cursor)

  const params = order.map((name) =>
    name in values && values[name] !== '' ? values[name] : null,
  )
  return { sql: out, params }
}
