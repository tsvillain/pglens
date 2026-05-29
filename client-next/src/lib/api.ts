import { z } from 'zod'

const ConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string().optional(),
  username: z.string().optional(),
  connectionString: z.string().optional(),
  sslMode: z.string().optional(),
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

// Server returns the envelope:
//   { error: { code, message, hint? }, errorMessage: <string mirror for v2> }
// During the strangler-fig migration we accept either shape so v3 keeps
// working against older pglens binaries.
const ApiErrorResponse = z.object({
  error: z
    .union([
      z.string(),
      z.object({
        code: z.string().optional(),
        message: z.string(),
        hint: z.string().optional(),
      }),
    ])
    .optional(),
  errorMessage: z.string().optional(),
})

export class ApiError extends Error {
  status: number
  code?: string
  hint?: string
  constructor(opts: { message: string; status: number; code?: string; hint?: string }) {
    super(opts.message)
    this.status = opts.status
    this.code = opts.code
    this.hint = opts.hint
  }
}

function parseErrorBody(body: unknown, status: number): ApiError {
  if (typeof body !== 'object' || body == null) {
    return new ApiError({ message: `HTTP ${status}`, status })
  }
  const parsed = ApiErrorResponse.safeParse(body)
  if (!parsed.success) {
    return new ApiError({ message: `HTTP ${status}`, status })
  }
  const { error, errorMessage } = parsed.data
  if (typeof error === 'object' && error) {
    return new ApiError({
      message: error.message,
      status,
      code: error.code,
      hint: error.hint,
    })
  }
  if (typeof error === 'string') {
    return new ApiError({ message: error, status })
  }
  if (errorMessage) {
    return new ApiError({ message: errorMessage, status })
  }
  return new ApiError({ message: `HTTP ${status}`, status })
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

  // `credentials: 'same-origin'` is the default but stated explicitly so the
  // pglens_token cookie always rides along.
  const res = await fetch(path, {
    headers,
    signal: opts.signal,
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw parseErrorBody(body, res.status)
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
  method: 'POST' | 'PUT' | 'PATCH' = 'POST',
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
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
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
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

const PatchSchemaResponse = z.object({ updated: z.boolean() })

export function patchSchema(connectionId: string, schema: string) {
  return postJson(
    `/api/connections/${encodeURIComponent(connectionId)}/schema`,
    { schema },
    PatchSchemaResponse,
    'PATCH',
  )
}

const DisconnectResponse = z.object({ connected: z.boolean() })

export async function disconnect(connectionId: string) {
  const res = await fetch('/api/disconnect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connection-id': connectionId,
    },
    body: JSON.stringify({ connectionId }),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return DisconnectResponse.parse(json)
}

export interface BackupProgress {
  bytes: number
  currentTable?: string
}

/**
 * Stream /api/export to disk while reporting progress. The server emits
 * `-- Table structure for table "..."` markers between sections, so we
 * peek into the decoded text to surface the current table name.
 */
export async function downloadBackup(
  connectionId: string,
  fileName = 'pglens_backup.sql',
  onProgress?: (p: BackupProgress) => void,
  signal?: AbortSignal,
) {
  const res = await fetch('/api/export', {
    headers: { 'x-connection-id': connectionId },
    credentials: 'same-origin',
    signal,
  })
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    throw parseErrorBody(json, res.status)
  }
  if (!res.body) {
    // Fallback for environments without ReadableStream.
    const blob = await res.blob()
    triggerDownload(blob, fileName)
    onProgress?.({ bytes: blob.size })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const chunks: BlobPart[] = []
  let bytes = 0
  let textBuffer = ''
  let currentTable: string | undefined
  const tableMarker = /Table structure for table "([^"]+)"/g

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    bytes += value.byteLength

    textBuffer += decoder.decode(value, { stream: true })
    let m: RegExpExecArray | null
    let last: string | undefined
    while ((m = tableMarker.exec(textBuffer)) !== null) last = m[1]
    if (last) currentTable = last
    // Trim so the buffer doesn't grow unbounded over a long export.
    if (textBuffer.length > 8192) textBuffer = textBuffer.slice(-4096)

    onProgress?.({ bytes, currentTable })
  }

  triggerDownload(new Blob(chunks, { type: 'application/sql' }), fileName)
  onProgress?.({ bytes, currentTable })
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export type ExportFormat = 'csv' | 'json' | 'sql'

const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  csv: 'csv',
  json: 'json',
  sql: 'sql',
}

export interface ExportProgress {
  bytes: number
}

export interface ExportTableOptions {
  filter?: FilterGroup | null
  sort?: SortEntry[] | null
  /** Subset of columns to include, in order. Omit/empty ⇒ all columns. */
  columns?: string[] | null
  limit?: number
}

/**
 * Stream a single table's rows to disk in the chosen format, respecting the
 * supplied filter, sort, and column subset. The body is read incrementally so
 * the browser never has to hold the whole table at once for large exports.
 */
export async function exportTableData(
  connectionId: string,
  tableName: string,
  format: ExportFormat,
  options: ExportTableOptions = {},
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportProgress> {
  const qs = new URLSearchParams()
  qs.set('format', format)
  if (options.filter && options.filter.children.length > 0) {
    qs.set('filter', JSON.stringify(options.filter))
  }
  if (options.sort && options.sort.length > 0) {
    qs.set('sort', JSON.stringify(options.sort))
  }
  if (options.columns && options.columns.length > 0) {
    qs.set('columns', JSON.stringify(options.columns))
  }
  if (options.limit) qs.set('limit', String(options.limit))

  const res = await fetch(
    `/api/tables/${encodeURIComponent(tableName)}/export?${qs.toString()}`,
    {
      headers: { 'x-connection-id': connectionId },
      credentials: 'same-origin',
      signal,
    },
  )
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    throw parseErrorBody(json, res.status)
  }

  const fileName = `${tableName}.${EXPORT_EXTENSION[format]}`
  const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream'

  if (!res.body) {
    // Fallback for environments without ReadableStream.
    const blob = await res.blob()
    triggerDownload(blob, fileName)
    onProgress?.({ bytes: blob.size })
    return { bytes: blob.size }
  }

  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    bytes += value.byteLength
    onProgress?.({ bytes })
  }

  triggerDownload(new Blob(chunks, { type: contentType }), fileName)
  onProgress?.({ bytes })
  return { bytes }
}

export function listSchemas(connectionId: string, signal?: AbortSignal) {
  return api('/api/schemas', SchemasResponse, { connectionId, signal })
}

export function listTables(connectionId: string, signal?: AbortSignal) {
  return api('/api/tables', TablesResponse, { connectionId, signal })
}

const ColumnMetaSchema = z.object({
  dataType: z.string(),
  // Real Postgres type name (e.g. `int4`, `_text`, enum name). Older
  // servers without this field still parse via `.optional()`.
  udtName: z.string().optional(),
  isNullable: z.boolean().optional(),
  hasDefault: z.boolean().optional(),
  // Raw default expression, surfaced so the insert form can ghost it. Older
  // servers without the field still parse via `.nullish()`.
  defaultValue: z.string().nullish(),
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

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'in' | 'nin'
  | 'is_null' | 'is_not_null'
  | 'jsonb_contains' | 'array_overlaps'

export interface FilterCondition {
  type: 'condition'
  column: string
  op: FilterOp
  value?: unknown
}

export interface FilterGroup {
  type: 'group'
  combinator: 'and' | 'or'
  children: Array<FilterCondition | FilterGroup>
}

export interface SortEntry {
  column: string
  direction: 'asc' | 'desc'
}

export interface TableQueryParams {
  page?: number
  limit?: number
  sort?: SortEntry[] | null
  filter?: FilterGroup | null
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

// ---- Saved views ------------------------------------------------------------

const FilterConditionApi = z.object({
  type: z.literal('condition'),
  column: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
})
type FilterGroupApi = {
  type: 'group'
  combinator: 'and' | 'or'
  children: Array<z.infer<typeof FilterConditionApi> | FilterGroupApi>
}
const FilterGroupApiSchema: z.ZodType<FilterGroupApi> = z.lazy(() =>
  z.object({
    type: z.literal('group'),
    combinator: z.enum(['and', 'or']),
    children: z.array(z.union([FilterConditionApi, FilterGroupApiSchema])),
  }),
)

const SortEntryApi = z.object({
  column: z.string(),
  direction: z.enum(['asc', 'desc', 'ASC', 'DESC']),
})

const SavedViewSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  tableName: z.string(),
  name: z.string(),
  filter: FilterGroupApiSchema.nullable().optional(),
  sort: z.array(SortEntryApi).optional(),
  visibleColumns: z.array(z.string()).nullable().optional(),
  columnWidths: z.record(z.string(), z.number()).nullable().optional(),
  timezone: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SavedView = z.infer<typeof SavedViewSchema>

const ListViewsResponse = z.object({ views: z.array(SavedViewSchema) })
const ViewEnvelope = z.object({ view: SavedViewSchema })

export interface SaveViewPayload {
  connectionId: string
  tableName: string
  name: string
  filter?: FilterGroup | null
  sort?: SortEntry[]
  visibleColumns?: string[] | null
  columnWidths?: Record<string, number> | null
  timezone?: string | null
}

export function listViews(
  params: { connectionId?: string; tableName?: string } = {},
  signal?: AbortSignal,
) {
  const qs = new URLSearchParams()
  if (params.connectionId) qs.set('connectionId', params.connectionId)
  if (params.tableName) qs.set('tableName', params.tableName)
  const q = qs.toString()
  return api(`/api/views${q ? '?' + q : ''}`, ListViewsResponse, { signal })
}

export async function createView(payload: SaveViewPayload): Promise<SavedView> {
  const res = await fetch('/api/views', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return ViewEnvelope.parse(json).view
}

export async function updateView(
  id: string,
  patch: Partial<SaveViewPayload>,
): Promise<SavedView> {
  const res = await fetch(`/api/views/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return ViewEnvelope.parse(json).view
}

export async function deleteView(id: string): Promise<void> {
  const res = await fetch(`/api/views/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    throw parseErrorBody(json, res.status)
  }
}

// ---- Inline row edit --------------------------------------------------------

const UpdateRowResponse = z.object({
  row: z.record(z.string(), z.unknown()),
})

export interface UpdateRowPayload {
  where: Record<string, unknown>
  set: Record<string, unknown>
}

export async function updateRow(
  connectionId: string,
  tableName: string,
  payload: UpdateRowPayload,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `/api/tables/${encodeURIComponent(tableName)}/rows`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-connection-id': connectionId,
      },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    },
  )
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return UpdateRowResponse.parse(json).row
}

// ---- Row insert -------------------------------------------------------------

const InsertRowResponse = z.object({
  row: z.record(z.string(), z.unknown()),
})

export interface InsertRowPayload {
  // Only the columns the user filled. Omitted columns take their DEFAULT;
  // an explicit `null` maps to SQL NULL.
  values: Record<string, unknown>
}

export async function insertRow(
  connectionId: string,
  tableName: string,
  payload: InsertRowPayload,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `/api/tables/${encodeURIComponent(tableName)}/rows`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connection-id': connectionId,
      },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    },
  )
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return InsertRowResponse.parse(json).row
}

// ---- CSV import -------------------------------------------------------------

export type ImportMode = 'insert' | 'skip' | 'update'

export interface ImportPayload {
  /** Target columns, in order. */
  columns: string[]
  /** Each row's cells, aligned to `columns`. */
  rows: unknown[][]
  mode: ImportMode
  /** ON CONFLICT key columns — required when `mode` is 'update'. */
  conflictColumns?: string[]
  /** Blank cell → NULL. Default true server-side. */
  emptyAsNull?: boolean
  /** Count only, then roll back. */
  dryRun?: boolean
}

const ImportResultResponse = z.object({
  dryRun: z.boolean(),
  mode: z.enum(['insert', 'skip', 'update']),
  attempted: z.number(),
  inserted: z.number(),
  updated: z.number(),
  conflicts: z.number(),
  batches: z.number().optional(),
})
export type ImportResult = z.infer<typeof ImportResultResponse>

export async function importTableData(
  connectionId: string,
  tableName: string,
  payload: ImportPayload,
): Promise<ImportResult> {
  const res = await fetch(
    `/api/tables/${encodeURIComponent(tableName)}/import`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connection-id': connectionId,
      },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    },
  )
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return ImportResultResponse.parse(json)
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
  if (params.sort && params.sort.length > 0) {
    qs.set('sort', JSON.stringify(params.sort))
  }
  if (params.filter && params.filter.children.length > 0) {
    qs.set('filter', JSON.stringify(params.filter))
  }
  const query = qs.toString()
  return api(
    `/api/tables/${encodeURIComponent(tableName)}${query ? '?' + query : ''}`,
    TableDataResponse,
    { connectionId, signal },
  )
}

// ---- Per-column aggregations ------------------------------------------------

// `fn` is one of the AggFn values in lib/aggSql; kept as a string here to avoid
// a circular import (aggSql depends on this module for FilterGroup).
export interface AggItem {
  column: string
  fn: string
}

const AggregateResponse = z.object({
  results: z.array(
    z.object({
      column: z.string(),
      fn: z.string(),
      value: z.unknown(),
    }),
  ),
})
export type AggregateResult = z.infer<typeof AggregateResponse>

export function getAggregates(
  connectionId: string,
  tableName: string,
  params: { filter?: FilterGroup | null; aggs: AggItem[] },
  signal?: AbortSignal,
) {
  const qs = new URLSearchParams()
  if (params.filter && params.filter.children.length > 0) {
    qs.set('filter', JSON.stringify(params.filter))
  }
  qs.set('aggs', JSON.stringify(params.aggs))
  return api(
    `/api/tables/${encodeURIComponent(tableName)}/aggregate?${qs.toString()}`,
    AggregateResponse,
    { connectionId, signal },
  )
}
