/**
 * Parse and analyze a PostgreSQL `EXPLAIN (FORMAT JSON)` plan into a normalized
 * node tree with derived metrics, for the §6.3 plan visualizer. This is the
 * analytical core (the "moat") — it is pure and heavily unit-tested; the
 * `ExplainPlan` component only renders what this produces.
 *
 * It accepts the plan in any shape the rest of the app can hand it:
 *   - the root object `{ "Plan": {...}, "Planning Time": ..., ... }` returned by
 *     the server's `extractExplainTiming()` (Advanced-mode Explain toggle);
 *   - the raw `[{ "Plan": {...}, ... }]` array Postgres returns, e.g. the
 *     `QUERY PLAN` column when an `EXPLAIN (FORMAT JSON) ...` runs as a normal
 *     query (no-code "Explain plan" / slow-query "Visualize plan");
 *   - a JSON string of either (some drivers/servers hand JSON columns back as
 *     text rather than parsed).
 *
 * PostgreSQL semantics that shape the derivations below:
 *   - `Actual Total Time` and `Actual Rows` are PER-LOOP averages. The real
 *     totals are multiplied by `Actual Loops` (this is what trips people up
 *     reading raw plans, and is exactly what the visualizer should surface).
 *   - `Plan Rows` is already a total estimate (not per-loop).
 *   - A node's "exclusive" (self) time/cost is its total minus its children's,
 *     which is what reveals *which* node is actually slow — a parent's total
 *     includes everything beneath it.
 */

/** A node-type's plain-English description, shown as a tooltip in the tree. */
const NODE_TYPE_DESCRIPTIONS: Record<string, string> = {
  'Seq Scan': 'Reads every row of the table in order. Cheap on small tables; on large ones an index usually beats it.',
  'Sample Scan': 'Reads a random sample of the table (TABLESAMPLE) rather than every row.',
  'Index Scan': 'Walks an index to find matching rows, then fetches each row from the table. Good for selective filters.',
  'Index Only Scan': 'Answers entirely from the index without touching the table — only possible when every needed column is in the index and the page is visible.',
  'Bitmap Heap Scan': 'Fetches the table rows flagged by a Bitmap Index Scan, in physical (heap) order to reduce random I/O.',
  'Bitmap Index Scan': 'Builds a bitmap of matching row locations from an index; feeds a Bitmap Heap Scan. Used when many rows match.',
  'Tid Scan': 'Fetches rows directly by physical tuple id (ctid).',
  'Subquery Scan': 'Reads the output of a sub-query as if it were a table.',
  'Function Scan': 'Reads the rows returned by a set-returning function.',
  'Table Function Scan': 'Reads the rows produced by a table function (e.g. XMLTABLE).',
  'Values Scan': 'Reads an inline VALUES list.',
  'CTE Scan': 'Reads the materialized output of a WITH (CTE) query.',
  'Named Tuplestore Scan': 'Reads rows from a named tuplestore (e.g. a trigger transition table).',
  'WorkTable Scan': 'Reads the working table of a recursive CTE on each recursion step.',
  'Foreign Scan': 'Reads rows from a foreign (external) table via a foreign data wrapper.',
  'Nested Loop': 'For each row on one side, scans the other side. Fast when the outer side is tiny or the inner has an index; quadratic when both sides are large.',
  'Hash Join': 'Builds a hash table of one side, then probes it with the other. Strong for large unsorted equality joins.',
  'Merge Join': 'Merges two inputs already sorted on the join key. Efficient when inputs are pre-sorted (e.g. from indexes).',
  Hash: 'Builds the in-memory hash table consumed by a Hash Join. Spills to disk (temp blocks) if it exceeds work_mem.',
  Sort: 'Sorts its input. Spills to disk when it exceeds work_mem — watch for "external merge".',
  'Incremental Sort': 'Sorts in batches, exploiting input rows already partially sorted by a prefix of the sort key.',
  Aggregate: 'Computes aggregates (COUNT, SUM, …) over its input.',
  GroupAggregate: 'Aggregates input that is already sorted by the grouping key.',
  HashAggregate: 'Aggregates by hashing the grouping key. Spills to disk if groups exceed work_mem.',
  MixedAggregate: 'Aggregates several grouping sets at once (GROUPING SETS / ROLLUP / CUBE).',
  WindowAgg: 'Computes window-function results (OVER (…)) over its input.',
  Unique: 'Removes adjacent duplicate rows from sorted input (DISTINCT / UNION).',
  SetOp: 'Computes INTERSECT / EXCEPT over its inputs.',
  Limit: 'Returns only the first N rows (LIMIT/OFFSET) and stops early.',
  Result: 'Evaluates an expression or a one-row result, or gates output with a one-time filter.',
  ProjectSet: 'Evaluates set-returning functions in the SELECT list.',
  Append: 'Concatenates the outputs of several child plans (UNION ALL, partitions).',
  'Merge Append': 'Merges several already-sorted child plans while preserving order.',
  Materialize: 'Caches its input in memory so an outer node can rescan it without recomputing.',
  Memoize: 'Caches inner-side results keyed by parameters, so repeated lookups in a Nested Loop are served from cache.',
  Gather: 'Collects rows from parallel worker processes (order not preserved).',
  'Gather Merge': 'Collects rows from parallel workers while preserving their sorted order.',
  Group: 'Groups already-sorted input without computing aggregates.',
  LockRows: 'Takes row locks for SELECT … FOR UPDATE/SHARE.',
  ModifyTable: 'Performs the INSERT / UPDATE / DELETE / MERGE.',
  Insert: 'Inserts rows into the target table.',
  Update: 'Updates rows in the target table.',
  Delete: 'Deletes rows from the target table.',
  Merge: 'Applies a MERGE statement.',
  'Recursive Union': 'Evaluates a recursive CTE: a base term unioned with the recursive term until no new rows.',
  BitmapAnd: 'Intersects several bitmaps (AND of index conditions).',
  BitmapOr: 'Unions several bitmaps (OR of index conditions).',
}

/** Plain-English description for a node type, or a generic fallback. */
export function describeNodeType(nodeType: string): string {
  return (
    NODE_TYPE_DESCRIPTIONS[nodeType] ??
    `A "${nodeType}" plan node.`
  )
}

/** One qualifier/detail line shown in a node's expandable panel. */
export interface PlanDetail {
  label: string
  value: string
}

export interface PlanNode {
  /** Pre-order index — stable React key and highlight target. */
  id: number
  nodeType: string
  /** A short, human label combining node type with its target relation/index. */
  label: string
  relationName: string | null
  schemaName: string | null
  alias: string | null
  indexName: string | null
  parentRelationship: string | null

  // Estimated (always present)
  startupCost: number
  totalCost: number
  planRows: number
  planWidth: number

  // Actual (present only with EXPLAIN ANALYZE)
  actualStartupTime: number | null
  /** Per-loop average, as Postgres reports it. */
  actualTotalTime: number | null
  /** Per-loop average, as Postgres reports it. */
  actualRows: number | null
  actualLoops: number | null
  neverExecuted: boolean

  // Parallelism
  workersPlanned: number | null
  workersLaunched: number | null

  // Buffers (present with EXPLAIN (ANALYZE, BUFFERS))
  sharedHitBlocks: number | null
  sharedReadBlocks: number | null
  tempReadBlocks: number | null
  tempWrittenBlocks: number | null

  // Derived
  /** actualTotalTime × loops — the node's real wall-clock contribution. */
  totalMs: number | null
  /** totalMs minus children's totalMs, clamped ≥ 0 — the node's own time. */
  exclusiveMs: number | null
  /** totalCost minus children's totalCost, clamped ≥ 0. */
  exclusiveCost: number
  /** actualRows × loops — the real number of rows produced. */
  actualRowsTotal: number | null
  /** Misestimate ratio ≥ 1 (planned vs actual rows); null without ANALYZE. */
  estimateFactor: number | null
  /** Whether the planner over- or under-estimated row count. */
  estimateDirection: 'over' | 'under' | null
  rowsRemovedByFilter: number | null

  details: PlanDetail[]
  /** The raw node object, for the "View raw JSON" escape hatch. */
  raw: Record<string, unknown>
  children: PlanNode[]
}

export interface PlanTrigger {
  name: string
  relation: string | null
  calls: number | null
  timeMs: number | null
}

export interface ParsedPlan {
  root: PlanNode
  /** Flattened pre-order — handy for maxima and counts. */
  nodes: PlanNode[]
  /** True when actual times are present (EXPLAIN ANALYZE vs plain EXPLAIN). */
  analyzed: boolean
  planningMs: number | null
  executionMs: number | null
  triggers: PlanTrigger[]

  // Maxima for heatmap scaling.
  maxExclusiveMs: number
  maxTotalCost: number
  maxRowsTotal: number
  /** Node with the largest exclusive time (or cost, when not analyzed). */
  slowestNodeId: number | null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Normalize whatever the caller passes into the root node object
 * (`{ "Plan": {...}, ... }`), or null if there's no recognizable plan.
 */
function normalizeRoot(input: unknown): Record<string, unknown> | null {
  let v: unknown = input
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  // The `QUERY PLAN` column and bare EXPLAIN output are single-element arrays.
  if (Array.isArray(v)) v = v[0]
  if (!v || typeof v !== 'object') return null
  const obj = v as Record<string, unknown>
  // A wrapper row like `{ "QUERY PLAN": [{ "Plan": ... }] }`.
  if (!('Plan' in obj) && 'QUERY PLAN' in obj) {
    return normalizeRoot(obj['QUERY PLAN'])
  }
  if (!('Plan' in obj) || typeof obj.Plan !== 'object' || obj.Plan == null) {
    return null
  }
  return obj
}

// Qualifier keys worth surfacing in the detail panel, in display order. These
// are the conditions/keys that explain *why* a node behaves as it does.
const DETAIL_KEYS: Array<[string, string]> = [
  ['Join Type', 'Join type'],
  ['Index Cond', 'Index cond'],
  ['Recheck Cond', 'Recheck cond'],
  ['Filter', 'Filter'],
  ['Hash Cond', 'Hash cond'],
  ['Merge Cond', 'Merge cond'],
  ['Join Filter', 'Join filter'],
  ['One-Time Filter', 'One-time filter'],
  ['Sort Key', 'Sort key'],
  ['Group Key', 'Group key'],
  ['Presorted Key', 'Presorted key'],
  ['Sort Method', 'Sort method'],
  ['Scan Direction', 'Scan direction'],
  ['Heap Fetches', 'Heap fetches'],
  ['Cache Mode', 'Cache mode'],
  ['Subplan Name', 'Subplan'],
]

function collectDetails(node: Record<string, unknown>): PlanDetail[] {
  const out: PlanDetail[] = []
  for (const [key, label] of DETAIL_KEYS) {
    const raw = node[key]
    if (raw == null) continue
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw)
    if (value.length > 0) out.push({ label, value })
  }
  return out
}

function buildLabel(
  nodeType: string,
  relationName: string | null,
  alias: string | null,
  indexName: string | null,
): string {
  if (indexName && (nodeType.includes('Index') || nodeType.includes('Bitmap'))) {
    const base = `${nodeType} using ${indexName}`
    return relationName ? `${base} on ${relationName}` : base
  }
  if (relationName) {
    const onTable = alias && alias !== relationName
      ? `${relationName} as ${alias}`
      : relationName
    return `${nodeType} on ${onTable}`
  }
  return nodeType
}

/**
 * Recursively convert a raw plan node into a PlanNode. `assignId` hands out
 * stable pre-order ids; derived metrics that need children (exclusive time /
 * cost) are computed after the children are built.
 */
function buildNode(
  raw: Record<string, unknown>,
  assignId: () => number,
): PlanNode {
  const id = assignId()
  const nodeType = str(raw['Node Type']) ?? 'Unknown'
  const relationName = str(raw['Relation Name'])
  const schemaName = str(raw['Schema'])
  const alias = str(raw['Alias'])
  const indexName = str(raw['Index Name'])

  const childrenRaw = Array.isArray(raw['Plans']) ? (raw['Plans'] as unknown[]) : []
  const children = childrenRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => buildNode(c, assignId))

  const totalCost = num(raw['Total Cost']) ?? 0
  const actualTotalTime = num(raw['Actual Total Time'])
  const actualRows = num(raw['Actual Rows'])
  const actualLoops = num(raw['Actual Loops'])
  const planRows = num(raw['Plan Rows']) ?? 0
  // Postgres marks a node it skipped (e.g. the unused side of a join) with
  // "Actual Loops": 0 / "Never Executed".
  const neverExecuted =
    raw['Never Executed'] === true || (actualLoops != null && actualLoops === 0)

  const loops = actualLoops ?? 1
  const totalMs =
    actualTotalTime != null && !neverExecuted ? actualTotalTime * loops : null
  const actualRowsTotal =
    actualRows != null && !neverExecuted ? actualRows * loops : null

  const childTotalMs = children.reduce((s, c) => s + (c.totalMs ?? 0), 0)
  const exclusiveMs = totalMs != null ? Math.max(0, totalMs - childTotalMs) : null

  const childTotalCost = children.reduce((s, c) => s + c.totalCost, 0)
  const exclusiveCost = Math.max(0, totalCost - childTotalCost)

  let estimateFactor: number | null = null
  let estimateDirection: 'over' | 'under' | null = null
  if (actualRowsTotal != null) {
    // Guard zeros so the ratio stays finite (a node that returned 0 rows but
    // was estimated to return many is still a meaningful over-estimate).
    const est = Math.max(planRows, 1)
    const act = Math.max(actualRowsTotal, 1)
    if (est >= act) {
      estimateFactor = est / act
      estimateDirection = 'over'
    } else {
      estimateFactor = act / est
      estimateDirection = 'under'
    }
  }

  return {
    id,
    nodeType,
    label: buildLabel(nodeType, relationName, alias, indexName),
    relationName,
    schemaName,
    alias,
    indexName,
    parentRelationship: str(raw['Parent Relationship']),
    startupCost: num(raw['Startup Cost']) ?? 0,
    totalCost,
    planRows,
    planWidth: num(raw['Plan Width']) ?? 0,
    actualStartupTime: num(raw['Actual Startup Time']),
    actualTotalTime,
    actualRows,
    actualLoops,
    neverExecuted,
    workersPlanned: num(raw['Workers Planned']),
    workersLaunched: num(raw['Workers Launched']),
    sharedHitBlocks: num(raw['Shared Hit Blocks']),
    sharedReadBlocks: num(raw['Shared Read Blocks']),
    tempReadBlocks: num(raw['Temp Read Blocks']),
    tempWrittenBlocks: num(raw['Temp Written Blocks']),
    totalMs,
    exclusiveMs,
    exclusiveCost,
    actualRowsTotal,
    estimateFactor,
    estimateDirection,
    rowsRemovedByFilter: num(raw['Rows Removed by Filter']),
    details: collectDetails(raw),
    raw,
    children,
  }
}

function flatten(node: PlanNode, out: PlanNode[]): void {
  out.push(node)
  for (const c of node.children) flatten(c, out)
}

function parseTriggers(root: Record<string, unknown>): PlanTrigger[] {
  const raw = root['Triggers']
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      name: str(t['Trigger Name']) ?? 'trigger',
      relation: str(t['Relation']),
      calls: num(t['Calls']),
      timeMs: num(t['Time']),
    }))
    // A trigger that never fired (0 time, 0 calls) is just noise.
    .filter((t) => (t.timeMs ?? 0) > 0 || (t.calls ?? 0) > 0)
}

/**
 * Parse + analyze an EXPLAIN (FORMAT JSON) plan. Returns null when the input
 * doesn't contain a recognizable plan, so callers can fall back to a raw view.
 */
export function parseExplainPlan(input: unknown): ParsedPlan | null {
  const root = normalizeRoot(input)
  if (!root) return null

  let counter = 0
  const tree = buildNode(root.Plan as Record<string, unknown>, () => counter++)

  const nodes: PlanNode[] = []
  flatten(tree, nodes)

  const analyzed = nodes.some((n) => n.actualTotalTime != null)

  let maxExclusiveMs = 0
  let maxTotalCost = 0
  let maxRowsTotal = 0
  for (const n of nodes) {
    if (n.exclusiveMs != null) maxExclusiveMs = Math.max(maxExclusiveMs, n.exclusiveMs)
    maxTotalCost = Math.max(maxTotalCost, n.totalCost)
    if (n.actualRowsTotal != null) maxRowsTotal = Math.max(maxRowsTotal, n.actualRowsTotal)
    else maxRowsTotal = Math.max(maxRowsTotal, n.planRows)
  }

  // The "slowest" node drives the headline highlight: by exclusive time when we
  // have actuals, otherwise by exclusive cost.
  let slowestNodeId: number | null = null
  let best = -1
  for (const n of nodes) {
    const v = analyzed ? (n.exclusiveMs ?? 0) : n.exclusiveCost
    if (v > best) {
      best = v
      slowestNodeId = n.id
    }
  }

  return {
    root: tree,
    nodes,
    analyzed,
    planningMs: num(root['Planning Time']),
    executionMs: num(root['Execution Time']),
    triggers: parseTriggers(root),
    maxExclusiveMs,
    maxTotalCost,
    maxRowsTotal,
    slowestNodeId,
  }
}

/** Heatmap metric the tree colors nodes by. */
export type HeatMetric = 'time' | 'rows' | 'cost' | 'none'

/**
 * A node's [0,1] contribution for the chosen metric, used to pick its heat
 * intensity. Time uses exclusive (self) time so a slow leaf lights up rather
 * than its parents; cost likewise uses exclusive cost.
 */
export function nodeHeat(node: PlanNode, plan: ParsedPlan, metric: HeatMetric): number {
  if (metric === 'none') return 0
  if (metric === 'time') {
    if (node.exclusiveMs == null || plan.maxExclusiveMs <= 0) return 0
    return node.exclusiveMs / plan.maxExclusiveMs
  }
  if (metric === 'cost') {
    if (plan.maxTotalCost <= 0) return 0
    return node.exclusiveCost / plan.maxTotalCost
  }
  // rows
  const rows = node.actualRowsTotal ?? node.planRows
  if (plan.maxRowsTotal <= 0) return 0
  return rows / plan.maxRowsTotal
}

/**
 * Map a [0,1] heat fraction to an `hsl` color (cool green → amber → red), or
 * null below a threshold so low-contribution nodes stay neutral and the eye is
 * drawn only to the costly ones.
 */
export function heatColor(fraction: number): string | null {
  if (!Number.isFinite(fraction) || fraction < 0.05) return null
  const f = Math.min(1, fraction)
  // 125° (green) → 0° (red). Saturation/lightness tuned to read on both themes.
  const hue = Math.round(125 * (1 - f))
  return `hsl(${hue}, 75%, 45%)`
}
