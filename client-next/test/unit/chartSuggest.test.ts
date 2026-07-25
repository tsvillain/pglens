import { describe, expect, it } from 'vitest'

import {
  classifyColumn,
  classifyColumns,
  suggestCharts,
} from '@/lib/chartSuggest'

describe('classifyColumn', () => {
  it('classifies by Postgres type name', () => {
    expect(classifyColumn('int4', [], 'n')).toBe('numeric')
    expect(classifyColumn('numeric', [], 'n')).toBe('numeric')
    expect(classifyColumn('timestamptz', [], 'd')).toBe('temporal')
    expect(classifyColumn('date', [], 'd')).toBe('temporal')
    expect(classifyColumn('text', [], 's')).toBe('categorical')
    expect(classifyColumn('bool', [], 's')).toBe('categorical')
  })

  it('sniffs values when the type is unknown', () => {
    const rows = [{ a: null }, { a: 42 }]
    expect(classifyColumn('', rows, 'a')).toBe('numeric')
    expect(classifyColumn('oid:99999', [{ a: '2024-01-01' }], 'a')).toBe(
      'temporal',
    )
    expect(classifyColumn('', [{ a: 'hello' }], 'a')).toBe('categorical')
  })
})

describe('suggestCharts', () => {
  it('suggests a line for temporal + numeric (time series)', () => {
    const cols = classifyColumns(
      [
        { name: 'day', type: 'date' },
        { name: 'count', type: 'int8' },
      ],
      [],
    )
    const [first] = suggestCharts(cols)
    expect(first).toMatchObject({ type: 'line', x: 'day', y: 'count' })
  })

  it('suggests a bar for categorical + numeric', () => {
    const cols = classifyColumns(
      [
        { name: 'status', type: 'text' },
        { name: 'total', type: 'numeric' },
      ],
      [],
    )
    expect(suggestCharts(cols).map((s) => s.type)).toContain('bar')
  })

  it('suggests a scatter for two numerics', () => {
    const cols = classifyColumns(
      [
        { name: 'x', type: 'float8' },
        { name: 'y', type: 'float8' },
      ],
      [],
    )
    expect(suggestCharts(cols).map((s) => s.type)).toContain('scatter')
  })

  it('returns nothing to plot with no numeric column', () => {
    const cols = classifyColumns(
      [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'uuid' },
      ],
      [],
    )
    expect(suggestCharts(cols)).toHaveLength(0)
  })
})
