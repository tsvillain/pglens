import { describe, expect, it } from 'vitest'

import { buildTableSelect } from '@/lib/tableSql'
import type { FilterGroup } from '@/lib/api'

const EMPTY: FilterGroup = { type: 'group', combinator: 'and', children: [] }

describe('buildTableSelect', () => {
  it('builds a bare SELECT with default limit', () => {
    expect(buildTableSelect({ tableName: 'users' })).toBe(
      'SELECT *\n  FROM "users"\n LIMIT 100;',
    )
  })

  it('quotes identifiers and escapes embedded quotes', () => {
    expect(buildTableSelect({ tableName: 'we"ird' })).toContain('FROM "we""ird"')
  })

  it('omits an empty filter', () => {
    expect(buildTableSelect({ tableName: 'users', filter: EMPTY })).not.toContain('WHERE')
  })

  it('renders a WHERE clause from the filter', () => {
    const filter: FilterGroup = {
      type: 'group',
      combinator: 'and',
      children: [{ type: 'condition', column: 'status', op: 'eq', value: 'active' }],
    }
    expect(buildTableSelect({ tableName: 'users', filter })).toContain(
      `WHERE "status" = 'active'`,
    )
  })

  it('renders ORDER BY with upper-cased directions, skipping blank columns', () => {
    const sql = buildTableSelect({
      tableName: 'users',
      sort: [
        { column: 'created_at', direction: 'desc' },
        { column: '', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
    })
    expect(sql).toContain(' ORDER BY "created_at" DESC, "id" ASC')
  })

  it('computes OFFSET from page and limit', () => {
    const sql = buildTableSelect({ tableName: 'users', limit: 50, page: 3 })
    expect(sql).toContain(' LIMIT 50 OFFSET 100')
  })

  it('omits OFFSET on page 1', () => {
    expect(buildTableSelect({ tableName: 'users', limit: 50, page: 1 })).not.toContain('OFFSET')
  })

  it('treats page < 1 as page 1 (no negative offset)', () => {
    expect(buildTableSelect({ tableName: 'users', page: 0 })).not.toContain('OFFSET')
  })
})
