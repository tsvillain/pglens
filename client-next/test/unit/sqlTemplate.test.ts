import { describe, expect, it } from 'vitest'

import { applyTemplate, extractTemplateVars, hasTemplateVars } from '@/lib/sqlTemplate'

describe('extractTemplateVars', () => {
  it('returns distinct names in first-occurrence order', () => {
    expect(
      extractTemplateVars('SELECT * FROM {{schema}}.{{table}} WHERE id = {{table}}'),
    ).toEqual(['schema', 'table'])
  })

  it('tolerates surrounding whitespace', () => {
    expect(extractTemplateVars('SELECT {{  col  }}')).toEqual(['col'])
  })

  it('ignores non-identifier braces', () => {
    expect(extractTemplateVars("SELECT '{{ }}', {{1bad}}, {{}}")).toEqual([])
  })

  it('returns empty for plain SQL', () => {
    expect(extractTemplateVars('SELECT now()')).toEqual([])
  })
})

describe('hasTemplateVars', () => {
  it('detects presence regardless of prior regex state', () => {
    expect(hasTemplateVars('SELECT {{a}}')).toBe(true)
    // Called twice to guard against a leaked `lastIndex` on the shared regex.
    expect(hasTemplateVars('SELECT {{a}}')).toBe(true)
    expect(hasTemplateVars('SELECT 1')).toBe(false)
  })
})

describe('applyTemplate', () => {
  it('substitutes provided values', () => {
    expect(
      applyTemplate('SELECT * FROM {{table}} LIMIT {{n}}', { table: 'orders', n: '10' }),
    ).toBe('SELECT * FROM orders LIMIT 10')
  })

  it('reuses a value across repeated occurrences', () => {
    expect(applyTemplate('{{a}} = {{a}}', { a: 'x' })).toBe('x = x')
  })

  it('leaves unfilled variables intact', () => {
    expect(applyTemplate('SELECT {{a}}, {{b}}', { a: '1' })).toBe('SELECT 1, {{b}}')
  })

  it('is a no-op when there are no variables', () => {
    expect(applyTemplate('SELECT now()', { a: '1' })).toBe('SELECT now()')
  })
})
