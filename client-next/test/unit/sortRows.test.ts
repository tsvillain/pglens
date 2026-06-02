import { describe, expect, it } from 'vitest'

import { sortRows } from '@/lib/sortRows'

describe('sortRows', () => {
  it('returns the input unchanged with no sort', () => {
    const rows = [{ a: 2 }, { a: 1 }]
    expect(sortRows(rows, [])).toBe(rows)
  })

  it('sorts numbers numerically, not lexically', () => {
    const rows = [{ a: 10 }, { a: 2 }, { a: 1 }]
    expect(sortRows(rows, [{ column: 'a', direction: 'asc' }])).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 10 },
    ])
  })

  it('honours descending direction', () => {
    const rows = [{ a: 1 }, { a: 3 }, { a: 2 }]
    expect(sortRows(rows, [{ column: 'a', direction: 'desc' }])).toEqual([
      { a: 3 },
      { a: 2 },
      { a: 1 },
    ])
  })

  it('puts nulls last regardless of direction', () => {
    const rows = [{ a: null }, { a: 2 }, { a: 1 }]
    expect(sortRows(rows, [{ column: 'a', direction: 'asc' }])).toEqual([
      { a: 1 },
      { a: 2 },
      { a: null },
    ])
    expect(sortRows(rows, [{ column: 'a', direction: 'desc' }])).toEqual([
      { a: 2 },
      { a: 1 },
      { a: null },
    ])
  })

  it('applies secondary sort keys and is stable on ties', () => {
    const rows = [
      { a: 1, b: 2, id: 'first' },
      { a: 1, b: 1, id: 'second' },
      { a: 1, b: 1, id: 'third' },
    ]
    expect(
      sortRows(rows, [
        { column: 'a', direction: 'asc' },
        { column: 'b', direction: 'asc' },
      ]),
    ).toEqual([
      { a: 1, b: 1, id: 'second' },
      { a: 1, b: 1, id: 'third' },
      { a: 1, b: 2, id: 'first' },
    ])
  })
})
