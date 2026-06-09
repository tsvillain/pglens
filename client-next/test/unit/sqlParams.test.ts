import { describe, expect, it } from 'vitest'

import { applyParams, extractParamNames } from '@/lib/sqlParams'

describe('extractParamNames', () => {
  it('finds named placeholders in first-occurrence order', () => {
    expect(
      extractParamNames('SELECT * FROM t WHERE a = :foo AND b = :bar'),
    ).toEqual(['foo', 'bar'])
  })

  it('dedupes repeated names but keeps order', () => {
    expect(
      extractParamNames('SELECT :x WHERE a = :y OR b = :x'),
    ).toEqual(['x', 'y'])
  })

  it('ignores :: casts', () => {
    expect(extractParamNames('SELECT :id::int FROM t')).toEqual(['id'])
    expect(extractParamNames("SELECT '1'::text")).toEqual([])
  })

  it('ignores colons inside string literals', () => {
    expect(extractParamNames("SELECT '12:00:00' WHERE x = :real")).toEqual(['real'])
  })

  it("ignores '' escaped quotes inside strings", () => {
    expect(extractParamNames("SELECT 'it''s :nope' , :yes")).toEqual(['yes'])
  })

  it('ignores colons inside quoted identifiers', () => {
    expect(extractParamNames('SELECT "we:ird" FROM t WHERE a = :p')).toEqual(['p'])
  })

  it('ignores line and block comments', () => {
    expect(extractParamNames('SELECT 1 -- :nope\nWHERE a = :yes')).toEqual(['yes'])
    expect(extractParamNames('SELECT /* :nope */ :yes')).toEqual(['yes'])
  })

  it('handles nested block comments', () => {
    expect(extractParamNames('/* a /* :no */ :still */ :yes')).toEqual(['yes'])
  })

  it('ignores dollar-quoted bodies', () => {
    expect(extractParamNames('SELECT $$ :nope $$ , :yes')).toEqual(['yes'])
    expect(extractParamNames('SELECT $tag$ :nope $tag$ , :yes')).toEqual(['yes'])
  })

  it('does not treat array slices as parameters', () => {
    expect(extractParamNames('SELECT arr[lo:hi] FROM t')).toEqual([])
  })

  it('does not match a bare colon followed by a non-identifier', () => {
    expect(extractParamNames('SELECT 1 : 2')).toEqual([])
  })
})

describe('applyParams', () => {
  it('rewrites :name to positional $n and orders values', () => {
    const { sql, params } = applyParams(
      'SELECT * FROM t WHERE a = :foo AND b = :bar',
      { foo: 'hello', bar: '42' },
    )
    expect(sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2')
    expect(params).toEqual(['hello', '42'])
  })

  it('reuses the same index for a repeated name', () => {
    const { sql, params } = applyParams(
      'SELECT :x WHERE a = :y OR b = :x',
      { x: '1', y: '2' },
    )
    expect(sql).toBe('SELECT $1 WHERE a = $2 OR b = $1')
    expect(params).toEqual(['1', '2'])
  })

  it('maps missing or empty values to null', () => {
    const { params } = applyParams('SELECT :a, :b', { a: '', b: 'x' })
    expect(params).toEqual([null, 'x'])
  })

  it('preserves :: casts while substituting', () => {
    const { sql } = applyParams('SELECT :id::int', { id: '7' })
    expect(sql).toBe('SELECT $1::int')
  })

  it('leaves a parameterless query unchanged', () => {
    const { sql, params } = applyParams('SELECT now()', {})
    expect(sql).toBe('SELECT now()')
    expect(params).toEqual([])
  })
})
