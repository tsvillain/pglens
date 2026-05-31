import { describe, expect, it } from 'vitest'

import { parseCsv } from '@/lib/csv'

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const { headers, rows } = parseCsv('id,name\n1,Ann\n2,Bob')
    expect(headers).toEqual(['id', 'name'])
    expect(rows).toEqual([
      ['1', 'Ann'],
      ['2', 'Bob'],
    ])
  })

  it('handles quoted fields with commas, quotes, and newlines', () => {
    const text = 'a,b\n"x,y","say ""hi"""\n"line1\nline2",z'
    const { rows } = parseCsv(text)
    expect(rows).toEqual([
      ['x,y', 'say "hi"'],
      ['line1\nline2', 'z'],
    ])
  })

  it('handles CRLF line endings', () => {
    const { headers, rows } = parseCsv('id,name\r\n1,Ann\r\n')
    expect(headers).toEqual(['id', 'name'])
    expect(rows).toEqual([['1', 'Ann']])
  })

  it('ignores a trailing newline without emitting an empty row', () => {
    const { rows } = parseCsv('id\n1\n2\n')
    expect(rows).toEqual([['1'], ['2']])
  })

  it('strips a leading UTF-8 BOM from the first header', () => {
    const { headers } = parseCsv('﻿id,name\n1,Ann')
    expect(headers).toEqual(['id', 'name'])
  })

  it('pads short rows and truncates overflow to the header width', () => {
    const { rows } = parseCsv('a,b,c\n1,2\n1,2,3,4')
    expect(rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3'],
    ])
  })

  it('synthesizes headers when hasHeader is false', () => {
    const { headers, rows } = parseCsv('1,Ann\n2,Bob', { hasHeader: false })
    expect(headers).toEqual(['column_1', 'column_2'])
    expect(rows).toEqual([
      ['1', 'Ann'],
      ['2', 'Bob'],
    ])
  })

  it('supports a custom delimiter', () => {
    const { headers, rows } = parseCsv('id\tname\n1\tAnn', { delimiter: '\t' })
    expect(headers).toEqual(['id', 'name'])
    expect(rows).toEqual([['1', 'Ann']])
  })

  it('returns empty result for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
  })
})
