import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError, cancelBackend, exportTableData, getOperationsOverview,
  importTableData, listConnections, runQuery, terminateBackend,
} from '@/lib/api'
import type { FilterGroup } from '@/lib/api'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

afterEach(() => {
  fetchMock.mockReset()
})

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe('ApiError parsing', () => {
  it('extracts code + message + hint from the v3 envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid token', hint: 'open via CLI' },
          errorMessage: 'Missing or invalid token',
        },
        { status: 401 },
      ),
    )
    await expect(listConnections()).rejects.toMatchObject({
      message: 'Missing or invalid token',
      status: 401,
      code: 'UNAUTHENTICATED',
      hint: 'open via CLI',
    })
  })

  it('falls back to the legacy string-error shape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'legacy text' }, { status: 400 }),
    )
    await expect(listConnections()).rejects.toMatchObject({
      message: 'legacy text',
      status: 400,
    })
  })

  it('falls back to errorMessage when error field is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ errorMessage: 'mirror only' }, { status: 500 }),
    )
    await expect(listConnections()).rejects.toMatchObject({
      message: 'mirror only',
      status: 500,
    })
  })

  it('defaults to "HTTP {status}" when the body has nothing usable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({}, { status: 503 }),
    )
    await expect(listConnections()).rejects.toMatchObject({
      message: 'HTTP 503',
      status: 503,
    })
  })
})

describe('listConnections', () => {
  it('parses + returns the connections array', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        connections: [{ id: 'abc', name: 'mydb', schema: 'public' }],
      }),
    )
    const result = await listConnections()
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]?.name).toBe('mydb')
  })
})

describe('runQuery', () => {
  it('sends the connection id header and parses the results envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            rows: [{ one: 1 }],
            fields: [{ name: 'one' }],
            rowCount: 1,
            command: 'SELECT',
            durationMs: 2,
          },
        ],
        durationMs: 5,
      }),
    )
    const result = await runQuery('conn-1', 'SELECT 1')
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect(((init as RequestInit).headers as Record<string, string>)['x-connection-id']).toBe('conn-1')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].rowCount).toBe(1)
    expect(result.results[0].command).toBe('SELECT')
  })

  it('parses multiple result sets from a multi-statement run', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { rows: [{ a: 1 }], fields: [{ name: 'a' }], rowCount: 1, command: 'SELECT', durationMs: 1 },
          { rows: [], fields: [], rowCount: 3, command: 'INSERT 0 3', durationMs: 1 },
        ],
        durationMs: 9,
      }),
    )
    const result = await runQuery('conn-1', 'SELECT 1; INSERT ...')
    expect(result.results).toHaveLength(2)
    expect(result.results[1].command).toBe('INSERT 0 3')
  })

  it('parses the EXPLAIN ANALYZE timing breakdown', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [],
        timing: { planningMs: 0.4, executionMs: 3.1, plan: { Plan: {} } },
        durationMs: 7,
      }),
    )
    const result = await runQuery('conn-1', 'SELECT 1', undefined, { explain: true })
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string).explain).toBe(true)
    expect(result.timing?.planningMs).toBe(0.4)
    expect(result.timing?.executionMs).toBe(3.1)
  })

  it('rethrows the new error envelope as ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'DB_ERROR', message: 'syntax error at or near "FOO"' } },
        { status: 400 },
      ),
    )
    await expect(runQuery('conn-1', 'FOO')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('exportTableData', () => {
  // Drive exportTableData down the `!res.body` fallback path so we don't need
  // to fake a ReadableStream; stub the DOM download primitives jsdom lacks.
  function downloadResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      body: null,
      headers: { get: () => 'text/csv; charset=utf-8' },
      blob: async () => new Blob([JSON.stringify(body)], { type: 'text/csv' }),
    } as unknown as Response
  }

  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  afterEach(() => {
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  })

  function stubDownload() {
    URL.createObjectURL = vi.fn(() => 'blob:stub')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  }

  it('encodes format, filter, sort, and column subset into the query string', async () => {
    stubDownload()
    fetchMock.mockResolvedValueOnce(downloadResponse([]))
    const filter: FilterGroup = {
      type: 'group',
      combinator: 'and',
      children: [{ type: 'condition', column: 'age', op: 'gt', value: 18 }],
    }
    await exportTableData('conn-1', 'users', 'csv', {
      filter,
      sort: [{ column: 'name', direction: 'asc' }],
      columns: ['id', 'name'],
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(((init as RequestInit).headers as Record<string, string>)['x-connection-id']).toBe('conn-1')
    const qs = new URL(url as string, 'http://x').searchParams
    expect(qs.get('format')).toBe('csv')
    expect(JSON.parse(qs.get('filter')!)).toEqual(filter)
    expect(JSON.parse(qs.get('sort')!)).toEqual([{ column: 'name', direction: 'asc' }])
    expect(JSON.parse(qs.get('columns')!)).toEqual(['id', 'name'])
  })

  it('omits empty filter and reports bytes streamed', async () => {
    stubDownload()
    fetchMock.mockResolvedValueOnce(downloadResponse([{ id: 1 }]))
    const result = await exportTableData('conn-1', 'users', 'json', {
      filter: { type: 'group', combinator: 'and', children: [] },
    })
    const [url] = fetchMock.mock.calls[0]
    const qs = new URL(url as string, 'http://x').searchParams
    expect(qs.has('filter')).toBe(false)
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('throws ApiError on a failed export', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'BAD_REQUEST', message: 'Unknown export column(s): nope' } }, { status: 400 }),
    )
    await expect(
      exportTableData('conn-1', 'users', 'csv', { columns: ['nope'] }),
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('importTableData', () => {
  it('POSTs the mapping, rows, and mode and parses the result envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        dryRun: true,
        mode: 'skip',
        attempted: 3,
        inserted: 2,
        updated: 0,
        conflicts: 1,
      }),
    )
    const result = await importTableData('conn-1', 'users', {
      columns: ['id', 'name'],
      rows: [['1', 'Ann'], ['2', 'Bob'], ['3', 'Cy']],
      mode: 'skip',
      dryRun: true,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/tables/users/import')
    expect((init as RequestInit).method).toBe('POST')
    expect(((init as RequestInit).headers as Record<string, string>)['x-connection-id']).toBe('conn-1')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.columns).toEqual(['id', 'name'])
    expect(body.mode).toBe('skip')
    expect(body.dryRun).toBe(true)
    expect(result.conflicts).toBe(1)
  })

  it('throws ApiError when the import is rejected', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'DB_ERROR', message: 'duplicate key value violates unique constraint' } },
        { status: 400 },
      ),
    )
    await expect(
      importTableData('conn-1', 'users', {
        columns: ['id'],
        rows: [['1']],
        mode: 'insert',
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('getOperationsOverview', () => {
  // A realistic overview: int4 counts arrive as numbers, bigint/numeric sizes
  // and epoch lags arrive as strings through the driver — both must parse.
  const overview = {
    activity: {
      data: [
        {
          pid: 42, usename: 'app', state: 'active', query: 'SELECT 1',
          wait_event_type: null, wait_event: null, age_seconds: '12.5',
        },
      ],
      error: null,
    },
    blocking: { data: [], error: null },
    replication: { data: null, error: 'permission denied for pg_stat_replication' },
    sizes: {
      data: {
        database: { name: 'mydb', bytes: '1048576', pretty: '1024 kB' },
        tables: [
          { name: 'users', total_bytes: '8192', table_bytes: '4096', index_bytes: '4096', total_pretty: '8192 bytes' },
        ],
      },
      error: null,
    },
    connections: {
      data: { total: 90, active: 10, idle: 80, idle_in_transaction: 0, max: 100, reserved: 3, level: 'warn' },
      error: null,
    },
  }

  it('sends the connection header and parses the section envelopes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(overview))
    const result = await getOperationsOverview('conn-1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/operations/overview')
    expect(((init as RequestInit).headers as Record<string, string>)['x-connection-id']).toBe('conn-1')
    // String-encoded numerics survive parsing untouched (UI coerces them).
    expect(result.sizes.data?.tables[0]?.total_bytes).toBe('8192')
    expect(result.connections.data?.level).toBe('warn')
    // A failed section is captured, not thrown.
    expect(result.replication.data).toBeNull()
    expect(result.replication.error).toMatch(/permission denied/)
  })
})

describe('backend actions', () => {
  it('cancelBackend POSTs the pid with the connection header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ cancelled: true }))
    const result = await cancelBackend('conn-1', 42)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/operations/cancel')
    expect((init as RequestInit).method).toBe('POST')
    expect(((init as RequestInit).headers as Record<string, string>)['x-connection-id']).toBe('conn-1')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ pid: 42 })
    expect(result.cancelled).toBe(true)
  })

  it('terminateBackend hits the terminate route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ terminated: false }))
    const result = await terminateBackend('conn-1', 99)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/operations/terminate')
    expect(result.terminated).toBe(false)
  })

  it('throws ApiError when Postgres rejects the action', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'DB_ERROR', message: 'must be a superuser to terminate' } },
        { status: 500 },
      ),
    )
    await expect(terminateBackend('conn-1', 1)).rejects.toBeInstanceOf(ApiError)
  })
})
