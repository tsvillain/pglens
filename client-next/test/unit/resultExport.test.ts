import { describe, expect, it } from 'vitest'

import { resultToCsv, resultToJson } from '@/lib/resultExport'

describe('resultToCsv', () => {
  it('emits a header then rows in column order', () => {
    const csv = resultToCsv(
      ['id', 'name'],
      [
        { id: 1, name: 'Ann' },
        { id: 2, name: 'Bob' },
      ],
    )
    expect(csv).toBe('id,name\r\n1,Ann\r\n2,Bob')
  })

  it('quotes fields with commas, quotes, or newlines', () => {
    const csv = resultToCsv(
      ['a', 'b'],
      [{ a: 'x,y', b: 'say "hi"' }, { a: 'line1\nline2', b: 'z' }],
    )
    expect(csv).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line1\nline2",z')
  })

  it('renders NULL as empty and objects as JSON', () => {
    const csv = resultToCsv(
      ['a', 'b'],
      [{ a: null, b: { k: 1 } }],
    )
    expect(csv).toBe('a,b\r\n,"{""k"":1}"')
  })

  it('uses the column order even when a row is missing a key', () => {
    const csv = resultToCsv(['a', 'b'], [{ b: 2 }])
    expect(csv).toBe('a,b\r\n,2')
  })
})

describe('resultToJson', () => {
  it('pretty-prints the rows as an array of objects', () => {
    expect(resultToJson([{ id: 1 }])).toBe('[\n  {\n    "id": 1\n  }\n]')
  })
})
