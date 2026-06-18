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

// One statement's result set (roadmap §5.4 — a multi-statement script yields
// one of these per statement, each its own result tab).
const StatementResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  fields: z.array(
    z.object({ name: z.string(), dataTypeID: z.number().optional() }),
  ),
  rowCount: z.number().nullable(),
  // The completed command tag (SELECT / INSERT / UPDATE / …), used to label the
  // result tab. Null for servers/statements that don't report one.
  command: z.string().nullable().optional(),
  durationMs: z.number(),
})
export type StatementResult = z.infer<typeof StatementResultSchema>

// EXPLAIN ANALYZE timing breakdown (roadmap §5.4). `plan` is the raw FORMAT JSON
// plan, kept for the (future §6.3) visualizer.
const ExplainTimingSchema = z.object({
  planningMs: z.number().nullable(),
  executionMs: z.number().nullable(),
  plan: z.unknown().nullable(),
})
export type ExplainTiming = z.infer<typeof ExplainTimingSchema>

const QueryResponse = z.object({
  results: z.array(StatementResultSchema),
  durationMs: z.number(),
  timing: ExplainTimingSchema.optional(),
})
export type QueryResult = z.infer<typeof QueryResponse>

export interface RunQueryOptions {
  /** Time the (single) statement with EXPLAIN ANALYZE instead of running it. */
  explain?: boolean
}

export async function runQuery(
  connectionId: string,
  sql: string,
  params?: unknown[],
  options: RunQueryOptions = {},
): Promise<QueryResult> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connection-id': connectionId,
    },
    body: JSON.stringify({ sql, params, explain: options.explain || undefined }),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return QueryResponse.parse(json)
}

// ---- Transaction mode (roadmap §5.3) ----------------------------------------

const TxQueryResponse = QueryResponse.extend({ txOpen: z.boolean() })
export type TxQueryResult = z.infer<typeof TxQueryResponse>

/**
 * Run a statement (or multi-statement script) inside the tab's transaction.
 * BEGIN runs implicitly on the first call for a tab; the same dedicated backend
 * serves every subsequent statement until commit/rollback. `txOpen` reflects
 * whether the tab still holds a transaction afterward.
 */
export async function runTxQuery(
  connectionId: string,
  tabId: string,
  sql: string,
  params?: unknown[],
  options: RunQueryOptions = {},
): Promise<TxQueryResult> {
  const res = await fetch('/api/tx/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ tabId, sql, params, explain: options.explain || undefined }),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return TxQueryResponse.parse(json)
}

const TxControlResponse = z.object({
  committed: z.boolean().optional(),
  rolledBack: z.boolean().optional(),
  hadTransaction: z.boolean(),
})

async function txControl(
  action: 'commit' | 'rollback',
  connectionId: string,
  tabId: string,
) {
  const res = await fetch(`/api/tx/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ tabId }),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return TxControlResponse.parse(json)
}

export function commitTx(connectionId: string, tabId: string) {
  return txControl('commit', connectionId, tabId)
}

export function rollbackTx(connectionId: string, tabId: string) {
  return txControl('rollback', connectionId, tabId)
}

const FormatResponse = z.object({ sql: z.string() })

/**
 * Pretty-print SQL server-side (roadmap §5.2). No connection needed — the
 * server formatter is a pure text transform.
 */
export async function formatSql(sql: string): Promise<string> {
  const { sql: formatted } = await postJson('/api/format', { sql }, FormatResponse)
  return formatted
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

// ---- Saved queries (roadmap §5.5) -------------------------------------------

const SavedQuerySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: z.string(),
  sql: z.string(),
  description: z.string().nullable().optional(),
  folder: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  // Postman-style `{{variable}}` default values (see lib/sqlTemplate.ts).
  variables: z.record(z.string(), z.string()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SavedQuery = z.infer<typeof SavedQuerySchema>

const ListSavedQueriesResponse = z.object({ savedQueries: z.array(SavedQuerySchema) })
const SavedQueryEnvelope = z.object({ savedQuery: SavedQuerySchema })
const ImportSavedQueriesResponse = z.object({
  savedQueries: z.array(SavedQuerySchema),
  count: z.number(),
})

export interface SaveQueryPayload {
  connectionId: string
  name: string
  sql: string
  description?: string | null
  folder?: string | null
  tags?: string[]
  variables?: Record<string, string> | null
}

/** A single saved query as it travels through export/import JSON. */
export type SaveQueryImport = Omit<SaveQueryPayload, 'connectionId'>

export function listSavedQueries(connectionId: string, signal?: AbortSignal) {
  const qs = new URLSearchParams({ connectionId })
  return api(`/api/saved-queries?${qs.toString()}`, ListSavedQueriesResponse, { signal })
}

export async function createSavedQuery(payload: SaveQueryPayload): Promise<SavedQuery> {
  const { savedQuery } = await postJson('/api/saved-queries', payload, SavedQueryEnvelope)
  return savedQuery
}

export async function updateSavedQuery(
  id: string,
  patch: Partial<SaveQueryPayload>,
): Promise<SavedQuery> {
  const { savedQuery } = await postJson(
    `/api/saved-queries/${encodeURIComponent(id)}`,
    patch,
    SavedQueryEnvelope,
    'PUT',
  )
  return savedQuery
}

export async function deleteSavedQuery(id: string): Promise<void> {
  const res = await fetch(`/api/saved-queries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    throw parseErrorBody(json, res.status)
  }
}

export async function importSavedQueries(
  connectionId: string,
  savedQueries: SaveQueryImport[],
): Promise<SavedQuery[]> {
  const res = await postJson(
    '/api/saved-queries/import',
    { connectionId, savedQueries },
    ImportSavedQueriesResponse,
  )
  return res.savedQueries
}

// ---- Query history (roadmap §5.5) -------------------------------------------

const QueryHistoryEntrySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  sql: z.string(),
  durationMs: z.number().nullable().optional(),
  rowCount: z.number().nullable().optional(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
  executedAt: z.string(),
})
export type QueryHistoryEntry = z.infer<typeof QueryHistoryEntrySchema>

const ListHistoryResponse = z.object({ entries: z.array(QueryHistoryEntrySchema) })
const ClearHistoryResponse = z.object({ cleared: z.boolean(), count: z.number() })

export interface AddHistoryPayload {
  connectionId: string
  sql: string
  durationMs?: number | null
  rowCount?: number | null
  success: boolean
  error?: string | null
}

export function listQueryHistory(
  connectionId: string,
  limit?: number,
  signal?: AbortSignal,
) {
  const qs = new URLSearchParams({ connectionId })
  if (limit) qs.set('limit', String(limit))
  return api(`/api/query-history?${qs.toString()}`, ListHistoryResponse, { signal })
}

export async function addQueryHistory(payload: AddHistoryPayload): Promise<void> {
  // Fire-and-forget from the caller's perspective; we still surface transport
  // errors so a caller that cares can `.catch()` them.
  await fetch('/api/query-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  })
}

export async function deleteQueryHistoryEntry(id: string): Promise<void> {
  const res = await fetch(`/api/query-history/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    throw parseErrorBody(json, res.status)
  }
}

export async function clearQueryHistory(connectionId: string): Promise<number> {
  const qs = new URLSearchParams({ connectionId })
  const res = await fetch(`/api/query-history?${qs.toString()}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return ClearHistoryResponse.parse(json).count
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

// ---- Live activity dashboard (roadmap §6.1) ---------------------------------

// Postgres bigint/numeric values (sizes, LSN lag, epoch seconds) arrive as
// strings through the driver, while int4 counts arrive as numbers. Accept
// either and let the UI coerce with Number() at the point of display.
const Numeric = z.union([z.number(), z.string()]).nullable()

const ActivitySessionSchema = z.object({
  pid: z.number(),
  usename: z.string().nullable(),
  application_name: z.string().nullable().optional(),
  client_addr: z.string().nullable().optional(),
  state: z.string().nullable(),
  wait_event_type: z.string().nullable().optional(),
  wait_event: z.string().nullable().optional(),
  backend_type: z.string().nullable().optional(),
  query: z.string().nullable(),
  backend_start: z.string().nullable().optional(),
  xact_start: z.string().nullable().optional(),
  query_start: z.string().nullable().optional(),
  state_change: z.string().nullable().optional(),
  age_seconds: Numeric.optional(),
  state_age_seconds: Numeric.optional(),
})
export type ActivitySession = z.infer<typeof ActivitySessionSchema>

const BlockingEntrySchema = z.object({
  blocked_pid: z.number(),
  blocked_user: z.string().nullable(),
  blocked_query: z.string().nullable(),
  wait_event_type: z.string().nullable().optional(),
  wait_event: z.string().nullable().optional(),
  blocking_pid: z.number(),
  blocking_user: z.string().nullable(),
  blocking_query: z.string().nullable(),
  blocking_state: z.string().nullable().optional(),
})
export type BlockingEntry = z.infer<typeof BlockingEntrySchema>

const ReplicationEntrySchema = z.object({
  pid: z.number(),
  usename: z.string().nullable().optional(),
  application_name: z.string().nullable().optional(),
  client_addr: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  sync_state: z.string().nullable().optional(),
  sent_lsn: z.string().nullable().optional(),
  replay_lsn: z.string().nullable().optional(),
  lag_bytes: Numeric.optional(),
  write_lag_seconds: Numeric.optional(),
  flush_lag_seconds: Numeric.optional(),
  replay_lag_seconds: Numeric.optional(),
})
export type ReplicationEntry = z.infer<typeof ReplicationEntrySchema>

const DatabaseSizeSchema = z
  .object({ name: z.string(), bytes: Numeric, pretty: z.string() })
  .nullable()
export type DatabaseSize = z.infer<typeof DatabaseSizeSchema>

const TableSizeSchema = z.object({
  name: z.string(),
  total_bytes: Numeric,
  table_bytes: Numeric,
  index_bytes: Numeric,
  total_pretty: z.string(),
})
export type TableSize = z.infer<typeof TableSizeSchema>

const SizesSchema = z.object({
  database: DatabaseSizeSchema,
  tables: z.array(TableSizeSchema),
})

const ConnectionStatsSchema = z.object({
  total: z.number(),
  active: z.number(),
  idle: z.number(),
  idle_in_transaction: z.number(),
  max: z.number().nullable(),
  reserved: z.number().nullable(),
  level: z.enum(['ok', 'warn']),
})
export type ConnectionStats = z.infer<typeof ConnectionStatsSchema>

// Every dashboard section is `{ data, error }` so one section failing (e.g.
// replication on a restricted role) renders as an inline warning, not a blank
// panel — mirrors getOverview() server-side.
export interface OpsSection<T> {
  data: T | null
  error: string | null
}
function section<T>(schema: z.ZodType<T>) {
  return z.object({ data: schema.nullable(), error: z.string().nullable() })
}

const OperationsOverviewSchema = z.object({
  activity: section(z.array(ActivitySessionSchema)),
  blocking: section(z.array(BlockingEntrySchema)),
  replication: section(z.array(ReplicationEntrySchema)),
  sizes: section(SizesSchema),
  connections: section(ConnectionStatsSchema),
})
export type OperationsOverview = z.infer<typeof OperationsOverviewSchema>

export function getOperationsOverview(connectionId: string, signal?: AbortSignal) {
  return api('/api/operations/overview', OperationsOverviewSchema, { connectionId, signal })
}

const BackendActionResponse = z.object({
  cancelled: z.boolean().optional(),
  terminated: z.boolean().optional(),
})

async function backendAction(
  action: 'cancel' | 'terminate',
  connectionId: string,
  pid: number,
) {
  const res = await fetch(`/api/operations/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    body: JSON.stringify({ pid }),
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return BackendActionResponse.parse(json)
}

/** Cancel the running query on a backend (gentle — keeps the session). */
export function cancelBackend(connectionId: string, pid: number) {
  return backendAction('cancel', connectionId, pid)
}

/** Terminate a whole backend session (hard — drops the connection). */
export function terminateBackend(connectionId: string, pid: number) {
  return backendAction('terminate', connectionId, pid)
}

// ---- Slow query view (roadmap §6.2) -----------------------------------------

// One pg_stat_statements aggregate. bigint counters (calls, rows, blocks)
// arrive as strings; the float8 `*_exec_time` values (milliseconds) arrive as
// numbers. `p95_exec_time_est` is derived server-side (mean + 1.6449·stddev,
// clamped) since pg_stat_statements stores no true percentiles.
const SlowStatementSchema = z.object({
  queryid: z.string(),
  query: z.string().nullable(),
  calls: Numeric,
  total_exec_time: Numeric,
  mean_exec_time: Numeric,
  stddev_exec_time: Numeric,
  min_exec_time: Numeric,
  max_exec_time: Numeric,
  p95_exec_time_est: z.number().nullable(),
  rows: Numeric,
  shared_blks_hit: Numeric,
  shared_blks_read: Numeric,
  shared_blks_dirtied: Numeric.optional(),
  shared_blks_written: Numeric,
  local_blks_hit: Numeric.optional(),
  local_blks_read: Numeric.optional(),
  temp_blks_read: Numeric,
  temp_blks_written: Numeric,
})
export type SlowStatement = z.infer<typeof SlowStatementSchema>

// The list is a small state machine so the UI shows the enable prompt vs. the
// table without parsing error strings — mirrors getStatements() server-side.
const StatementsResponseSchema = z.object({
  status: z.enum(['ready', 'not_installed', 'not_loaded']),
  available: z.boolean(),
  ddl: z.string().optional(),
  statements: z.array(SlowStatementSchema),
})
export type StatementsResponse = z.infer<typeof StatementsResponseSchema>

// Sortable metrics (roadmap §6.2). Mirrors the server-side allowlist.
export type StatementSort = 'total_exec_time' | 'mean_exec_time' | 'calls'

export function getSlowStatements(
  connectionId: string,
  sort: StatementSort,
  limit?: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ sort })
  if (limit) params.set('limit', String(limit))
  return api(`/api/operations/statements?${params}`, StatementsResponseSchema, {
    connectionId,
    signal,
  })
}

const StatementActionResponse = z.object({
  reset: z.boolean().optional(),
  enabled: z.boolean().optional(),
  installed: z.boolean().optional(),
  available: z.boolean().optional(),
})
export type StatementActionResult = z.infer<typeof StatementActionResponse>

async function statementsAction(action: 'enable' | 'reset', connectionId: string) {
  const res = await fetch(`/api/operations/statements/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-connection-id': connectionId },
    credentials: 'same-origin',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw parseErrorBody(json, res.status)
  return StatementActionResponse.parse(json)
}

/** Create pg_stat_statements (idempotent; needs a privileged role). */
export function enableStatements(connectionId: string) {
  return statementsAction('enable', connectionId)
}

/** Discard all collected statistics (roadmap §6.2: "Reset stats"). */
export function resetStatements(connectionId: string) {
  return statementsAction('reset', connectionId)
}
