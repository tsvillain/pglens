import type { SchemaTable } from '@/lib/api'

/**
 * Sanitize a Postgres data type into a Mermaid-friendly token.
 * Mermaid accepts a single identifier-ish token, no spaces, no parens.
 */
function mermaidType(t: string): string {
  return t.replace(/\s+/g, '_').replace(/[()[\],]/g, '') || 'unknown'
}

function mermaidName(name: string): string {
  // Quote names that would otherwise break Mermaid's identifier rules.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '')}"`
}

/**
 * Render an `erDiagram` block from the introspected schema.
 *
 * Output is paste-ready into GitHub, Notion, Obsidian, mermaid.live, etc.
 */
export function toMermaidER(tables: SchemaTable[]): string {
  const lines: string[] = ['erDiagram']

  for (const t of tables) {
    const safe = mermaidName(t.name)
    lines.push(`  ${safe} {`)
    for (const c of t.columns) {
      const type = mermaidType(c.type)
      const flags: string[] = []
      if (c.isPrimaryKey) flags.push('PK')
      if (c.isForeignKey) flags.push('FK')
      if (c.isUnique && !c.isPrimaryKey) flags.push('UK')
      lines.push(`    ${type} ${mermaidName(c.name)}${flags.length ? ' ' + flags.join(',') : ''}`)
    }
    lines.push('  }')
  }

  // Relationships
  const known = new Set(tables.map((t) => t.name))
  for (const t of tables) {
    for (const c of t.columns) {
      const ref = c.foreignKeyRef
      if (!ref) continue
      if (!known.has(ref.table)) continue
      // child }o--|| parent : "column"
      const childCard = c.isUnique || c.isPrimaryKey ? '||' : '}o'
      lines.push(
        `  ${mermaidName(t.name)} ${childCard}--|| ${mermaidName(ref.table)} : ${mermaidName(c.name)}`,
      )
    }
  }

  return lines.join('\n')
}
