import { describe, expect, it } from 'vitest'

import { buildExplainSql } from '@/lib/explainSql'

describe('buildExplainSql', () => {
  it('uses GENERIC_PLAN for a normalized (parameterized) statement', () => {
    const out = buildExplainSql('SELECT * FROM users WHERE id = $1')
    expect(out).toMatch(/EXPLAIN \(GENERIC_PLAN\)/)
    expect(out).toContain('SELECT * FROM users WHERE id = $1')
    // The original query body is preserved verbatim after the explain prefix.
    expect(out.endsWith('SELECT * FROM users WHERE id = $1')).toBe(true)
  })

  it('detects placeholders anywhere, including DML with several params', () => {
    const out = buildExplainSql('INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT (a) DO UPDATE SET b = $2')
    expect(out).toMatch(/EXPLAIN \(GENERIC_PLAN\)/)
  })

  it('uses a plain EXPLAIN when there are no placeholders', () => {
    const out = buildExplainSql('SELECT now()')
    expect(out).toBe('EXPLAIN\nSELECT now()')
    expect(out).not.toMatch(/GENERIC_PLAN/)
  })

  it('does not treat a dollar-quoted body as a placeholder', () => {
    // $$…$$ and $tag$ are dollar quoting, not parameters — plain EXPLAIN.
    const out = buildExplainSql("SELECT $$literal $ text$$")
    expect(out).not.toMatch(/GENERIC_PLAN/)
  })

  it('trims surrounding whitespace before building', () => {
    expect(buildExplainSql('  SELECT 1  ')).toBe('EXPLAIN\nSELECT 1')
  })
})
