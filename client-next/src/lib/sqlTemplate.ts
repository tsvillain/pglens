/**
 * Postman-style `{{variable}}` template substitution for saved queries
 * (roadmap §5.5).
 *
 * This is a deliberately separate layer from the `:name` bound parameters of
 * the Advanced editor (roadmap §5.2 / `sqlParams.ts`):
 *
 *   - `{{variable}}` are *template variables* — resolved client-side by literal
 *     text substitution when a saved query is loaded into the editor. They can
 *     stand in for anything (identifiers, fragments, literals); the user
 *     reviews the resolved SQL in the editor before running it.
 *   - `:name` are *bound parameters* — rewritten to `$n` and shipped as a params
 *     array so the server stays parameterized (never string-interpolated).
 *
 * A loaded saved query can therefore use `{{schema}}.{{table}}` for the shape
 * and `:id` for a runtime-bound value, and each is handled by its own layer.
 *
 * The scanner only recognizes identifier-shaped names (`{{ a_b1 }}`, optional
 * surrounding whitespace) so stray `{{` in string literals or JSON rarely
 * matches by accident.
 */

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** Distinct `{{variable}}` names in first-occurrence order. */
export function extractTemplateVars(sql: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of sql.matchAll(VAR_RE)) {
    const name = m[1]
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/** True when the SQL contains at least one `{{variable}}`. */
export function hasTemplateVars(sql: string): boolean {
  VAR_RE.lastIndex = 0
  return VAR_RE.test(sql)
}

/**
 * Replace each `{{variable}}` with its value from `values`. A variable with no
 * entry (or an explicit `undefined`) is left intact as `{{name}}` so an
 * incomplete fill is visible in the editor rather than silently blanked.
 */
export function applyTemplate(sql: string, values: Record<string, string>): string {
  return sql.replace(VAR_RE, (_full, name: string) =>
    name in values && values[name] !== undefined ? values[name] : `{{${name}}}`,
  )
}
