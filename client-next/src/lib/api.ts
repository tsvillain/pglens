import { z } from 'zod'

const ConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string().optional(),
  database: z.string().optional(),
  schema: z.string().optional(),
  type: z.string().optional(),
})
export type Connection = z.infer<typeof ConnectionSchema>

const ConnectionsResponse = z.object({
  connections: z.array(ConnectionSchema),
})

const TableSchema = z.object({
  name: z.string(),
  type: z.enum(['table', 'view']),
})
export type Table = z.infer<typeof TableSchema>

const TablesResponse = z.object({
  tables: z.array(TableSchema),
})

const SchemasResponse = z.object({
  schemas: z.array(z.string()),
})

const ApiErrorResponse = z.object({
  error: z.string(),
})

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

interface FetchOptions {
  connectionId?: string
  signal?: AbortSignal
}

async function api<T>(
  path: string,
  schema: z.ZodSchema<T>,
  opts: FetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.connectionId) headers['x-connection-id'] = opts.connectionId

  const res = await fetch(path, { headers, signal: opts.signal })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = ApiErrorResponse.parse(await res.json())
      message = body.error
    } catch {
      // keep default
    }
    throw new ApiError(message, res.status)
  }
  return schema.parse(await res.json())
}

export function listConnections(signal?: AbortSignal) {
  return api('/api/connections', ConnectionsResponse, { signal })
}

const ConnectResponse = z.object({
  connected: z.boolean(),
  connectionId: z.string().optional(),
  name: z.string().optional(),
  error: z.string().optional(),
})

const UpdateConnectionResponse = z.object({
  updated: z.boolean(),
  connectionId: z.string().optional(),
  name: z.string().optional(),
  error: z.string().optional(),
})

export interface ConnectPayload {
  url: string
  sslMode?: 'prefer' | 'require' | 'disable' | 'verify-ca' | 'verify-full'
  name?: string
  schema?: string
}

async function postJson<T>(
  path: string,
  body: unknown,
  schema: z.ZodSchema<T>,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      (typeof json === 'object' && json && 'error' in json
        ? String((json as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`
    throw new ApiError(message, res.status)
  }
  return schema.parse(json)
}

export function connect(payload: ConnectPayload) {
  return postJson('/api/connect', payload, ConnectResponse)
}

const QueryResponse = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  fields: z.array(
    z.object({ name: z.string(), dataTypeID: z.number().optional() }),
  ),
  rowCount: z.number().nullable(),
  durationMs: z.number(),
})
export type QueryResult = z.infer<typeof QueryResponse>

export async function runQuery(
  connectionId: string,
  sql: string,
  params?: unknown[],
): Promise<QueryResult> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connection-id': connectionId,
    },
    body: JSON.stringify({ sql, params }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      typeof json === 'object' && json && 'error' in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`
    throw new ApiError(message, res.status)
  }
  return QueryResponse.parse(json)
}

export function updateConnectionApi(id: string, payload: ConnectPayload) {
  return postJson(
    `/api/connections/${encodeURIComponent(id)}`,
    payload,
    UpdateConnectionResponse,
    'PUT',
  )
}

export function listSchemas(connectionId: string, signal?: AbortSignal) {
  return api('/api/schemas', SchemasResponse, { connectionId, signal })
}

export function listTables(connectionId: string, signal?: AbortSignal) {
  return api('/api/tables', TablesResponse, { connectionId, signal })
}

const ColumnMetaSchema = z.object({
  dataType: z.string(),
  isPrimaryKey: z.boolean(),
  isForeignKey: z.boolean(),
  foreignKeyRef: z
    .object({ table: z.string(), column: z.string() })
    .nullable(),
  isUnique: z.boolean(),
})
export type ColumnMeta = z.infer<typeof ColumnMetaSchema>

const TableDataResponse = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  totalCount: z.number(),
  page: z.number(),
  limit: z.number(),
  isApproximate: z.boolean(),
  nextCursor: z.union([z.string(), z.number(), z.null()]).nullable(),
  hasPrimaryKey: z.boolean(),
  columns: z.record(z.string(), ColumnMetaSchema),
})
export type TableData = z.infer<typeof TableDataResponse>

export interface TableQueryParams {
  page?: number
  limit?: number
  sortColumn?: string | null
  sortDirection?: 'asc' | 'desc'
}

const SchemaColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  maxLength: z.number().nullable(),
  isNullable: z.boolean(),
  isPrimaryKey: z.boolean(),
  isUnique: z.boolean(),
  isForeignKey: z.boolean(),
  foreignKeyRef: z
    .object({ table: z.string(), column: z.string() })
    .nullable(),
})
export type SchemaColumn = z.infer<typeof SchemaColumnSchema>

const SchemaTableSchema = z.object({
  name: z.string(),
  columns: z.array(SchemaColumnSchema),
})
export type SchemaTable = z.infer<typeof SchemaTableSchema>

const SchemaResponse = z.object({
  schema: z.record(z.string(), SchemaTableSchema),
})

export function getDatabaseSchema(connectionId: string, signal?: AbortSignal) {
  return api('/api/schema', SchemaResponse, { connectionId, signal })
}

export function getTableData(
  connectionId: string,
  tableName: string,
  params: TableQueryParams = {},
  signal?: AbortSignal,
) {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.sortColumn) {
    qs.set('sortColumn', params.sortColumn)
    qs.set('sortDirection', params.sortDirection ?? 'asc')
  }
  const query = qs.toString()
  return api(
    `/api/tables/${encodeURIComponent(tableName)}${query ? '?' + query : ''}`,
    TableDataResponse,
    { connectionId, signal },
  )
}
