import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Flame,
  HardDrive,
  Info,
  Layers,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { JsonViewer } from '@/components/JsonViewer'
import {
  describeNodeType,
  heatColor,
  nodeHeat,
  parseExplainPlan,
  type HeatMetric,
  type ParsedPlan,
  type PlanNode,
} from '@/lib/explainPlan'
import { formatCount, formatMs } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * EXPLAIN plan visualizer (roadmap §6.3). Renders the parsed `EXPLAIN (FORMAT
 * JSON)` tree top-down (final node at the root, its inputs nested beneath),
 * with a heatmap over the chosen metric, actual-vs-estimated rows, plain-English
 * node tooltips, and an EXPLAIN vs EXPLAIN ANALYZE indication.
 *
 * `raw` is the plan in any shape parseExplainPlan accepts. `totalMs` is the
 * run's wall-clock (only known by the caller) shown alongside the planner's
 * planning/execution split.
 */
export function ExplainPlan({
  raw,
  totalMs = null,
}: {
  raw: unknown
  totalMs?: number | null
}) {
  const plan = useMemo(() => parseExplainPlan(raw), [raw])
  const [metric, setMetric] = useState<HeatMetric>(() =>
    plan?.analyzed ? 'time' : 'cost',
  )
  const [showRaw, setShowRaw] = useState(false)

  if (!plan) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">
          Couldn’t parse the query plan. Showing the raw output.
        </p>
        <div className="min-h-0 overflow-auto rounded-md border border-border bg-card p-3">
          <JsonViewer value={raw} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PlanSummary
        plan={plan}
        totalMs={totalMs}
        metric={metric}
        onMetric={setMetric}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw((v) => !v)}
      />

      {showRaw ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-card p-3">
          <JsonViewer value={raw} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <PlanNodeCard node={plan.root} plan={plan} metric={metric} depth={0} />
        </div>
      )}
    </div>
  )
}

// ---- Summary header ---------------------------------------------------------

function PlanSummary({
  plan,
  totalMs,
  metric,
  onMetric,
  showRaw,
  onToggleRaw,
}: {
  plan: ParsedPlan
  totalMs: number | null
  metric: HeatMetric
  onMetric: (m: HeatMetric) => void
  showRaw: boolean
  onToggleRaw: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium',
          plan.analyzed
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : 'bg-muted text-muted-foreground',
        )}
        title={
          plan.analyzed
            ? 'EXPLAIN ANALYZE — actual times from running the statement'
            : 'Plain EXPLAIN — planner estimates only; the statement was not executed'
        }
      >
        {plan.analyzed ? 'EXPLAIN ANALYZE' : 'EXPLAIN (estimated)'}
      </span>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {plan.planningMs != null && (
          <Stat label="Planning" value={formatMs(plan.planningMs)} />
        )}
        {plan.executionMs != null && (
          <Stat label="Execution" value={formatMs(plan.executionMs)} />
        )}
        {totalMs != null && <Stat label="Total" value={`${totalMs} ms`} />}
        <Stat label="Nodes" value={String(plan.nodes.length)} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <MetricToggle metric={metric} analyzed={plan.analyzed} onChange={onMetric} />
        <Button
          size="sm"
          variant={showRaw ? 'default' : 'outline'}
          aria-pressed={showRaw}
          onClick={onToggleRaw}
          title="Show the raw FORMAT JSON plan"
        >
          <Code2 className="h-3.5 w-3.5" /> JSON
        </Button>
      </div>

      {plan.triggers.length > 0 && (
        <p className="w-full text-xs text-amber-600 dark:text-amber-400">
          {plan.triggers.map((t) => (
            <span key={t.name} className="mr-3">
              Trigger <span className="font-mono">{t.name}</span>: {formatMs(t.timeMs)} ·{' '}
              {formatCount(t.calls)} calls
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

const METRICS: { value: HeatMetric; label: string; analyzedOnly?: boolean }[] = [
  { value: 'time', label: 'Time', analyzedOnly: true },
  { value: 'rows', label: 'Rows' },
  { value: 'cost', label: 'Cost' },
  { value: 'none', label: 'Off' },
]

function MetricToggle({
  metric,
  analyzed,
  onChange,
}: {
  metric: HeatMetric
  analyzed: boolean
  onChange: (m: HeatMetric) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Highlight by"
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs"
    >
      {METRICS.map(({ value, label, analyzedOnly }) => {
        const disabled = analyzedOnly && !analyzed
        const active = metric === value
        return (
          <button
            key={value}
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(value)}
            title={
              disabled ? 'Run with EXPLAIN ANALYZE to highlight by time' : `Highlight by ${label.toLowerCase()}`
            }
            className={cn(
              'rounded px-2 py-0.5 transition',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

// ---- Node tree --------------------------------------------------------------

function PlanNodeCard({
  node,
  plan,
  metric,
  depth,
}: {
  node: PlanNode
  plan: ParsedPlan
  metric: HeatMetric
  depth: number
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState(false)
  const hasChildren = node.children.length > 0
  const isSlowest = node.id === plan.slowestNodeId

  const heat = nodeHeat(node, plan, metric)
  const color = heatColor(heat)
  const share = metricShare(node, plan, metric)

  return (
    <div className="relative">
      <div
        className={cn(
          'rounded-md border bg-card transition-colors',
          isSlowest ? 'border-orange-500/60' : 'border-border',
        )}
        style={color ? { borderLeftColor: color, borderLeftWidth: 3 } : undefined}
      >
        <div className="flex items-start gap-2 px-2.5 py-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className={cn(
              'mt-0.5 text-muted-foreground hover:text-foreground',
              !hasChildren && 'invisible',
            )}
            aria-label={collapsed ? 'Expand children' : 'Collapse children'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="cursor-help font-medium"
                title={describeNodeType(node.nodeType)}
              >
                {node.label}
              </span>
              {isSlowest && (
                <Badge tone="orange" title="Highest self-time (or cost) in the plan">
                  <Flame className="h-3 w-3" /> slowest
                </Badge>
              )}
              {node.neverExecuted && (
                <Badge tone="muted" title="The planner produced this node but it never ran">
                  never executed
                </Badge>
              )}
              <MisestimateBadge node={node} />
              {(node.tempWrittenBlocks ?? 0) > 0 && (
                <Badge tone="amber" title="Spilled to temporary disk files (exceeded work_mem)">
                  <HardDrive className="h-3 w-3" /> disk
                </Badge>
              )}
              {(node.actualLoops ?? 1) > 1 && (
                <Badge tone="muted" title="Number of times this node was executed">
                  <Layers className="h-3 w-3" /> {formatCount(node.actualLoops)}× loops
                </Badge>
              )}
            </div>

            <NodeMetrics node={node} plan={plan} metric={metric} share={share} />

            {(node.details.length > 0 || (node.rowsRemovedByFilter ?? 0) > 0) && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3 w-3" />
                {open ? 'Hide details' : 'Details'}
              </button>
            )}

            {open && <NodeDetails node={node} />}
          </div>
        </div>
      </div>

      {hasChildren && !collapsed && (
        <div className="ml-3 mt-1.5 space-y-1.5 border-l border-border pl-3">
          {node.children.map((child) => (
            <PlanNodeCard
              key={child.id}
              node={child}
              plan={plan}
              metric={metric}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The compact metric chips beneath a node's title. */
function NodeMetrics({
  node,
  plan,
  metric,
  share,
}: {
  node: PlanNode
  plan: ParsedPlan
  metric: HeatMetric
  share: number | null
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {plan.analyzed && node.exclusiveMs != null && (
        <span
          className={cn('tabular-nums', metric === 'time' && 'font-medium text-foreground')}
          title={`Self time ${formatMs(node.exclusiveMs)} · total (incl. children) ${formatMs(node.totalMs)}`}
        >
          self {formatMs(node.exclusiveMs)}
          {share != null && metric === 'time' && (
            <span className="ml-1 text-muted-foreground">({pct(share)})</span>
          )}
        </span>
      )}

      <RowsMetric node={node} highlight={metric === 'rows'} />

      <span
        className={cn('tabular-nums', metric === 'cost' && 'font-medium text-foreground')}
        title={`Estimated startup cost ${node.startupCost} · total cost ${node.totalCost}`}
      >
        cost {formatCount(node.totalCost)}
        {share != null && metric === 'cost' && (
          <span className="ml-1 text-muted-foreground">({pct(share)})</span>
        )}
      </span>

      <BuffersMetric node={node} />
    </div>
  )
}

function RowsMetric({ node, highlight }: { node: PlanNode; highlight: boolean }) {
  const actual = node.actualRowsTotal
  if (actual == null) {
    // Plain EXPLAIN — estimate only.
    return (
      <span className={cn('tabular-nums', highlight && 'font-medium text-foreground')}>
        rows ~{formatCount(node.planRows)}
      </span>
    )
  }
  return (
    <span
      className={cn('tabular-nums', highlight && 'font-medium text-foreground')}
      title={`Actual ${actual.toLocaleString()} rows vs estimated ${node.planRows.toLocaleString()}`}
    >
      rows {formatCount(actual)}{' '}
      <span className="text-muted-foreground/70">(est {formatCount(node.planRows)})</span>
    </span>
  )
}

function BuffersMetric({ node }: { node: PlanNode }) {
  const hit = node.sharedHitBlocks
  const read = node.sharedReadBlocks
  if (hit == null && read == null) return null
  if ((hit ?? 0) === 0 && (read ?? 0) === 0) return null
  return (
    <span
      className="tabular-nums"
      title="Shared buffer blocks: cache hits vs reads from disk (8 KB each)"
    >
      buffers {formatCount(hit ?? 0)} hit
      {(read ?? 0) > 0 && <> · {formatCount(read)} read</>}
    </span>
  )
}

function MisestimateBadge({ node }: { node: PlanNode }) {
  const factor = node.estimateFactor
  if (factor == null || factor < 10) return null
  const tone = factor >= 100 ? 'red' : 'amber'
  const word = node.estimateDirection === 'under' ? 'under' : 'over'
  return (
    <Badge
      tone={tone}
      title={`Planner ${word}-estimated row count by ~${Math.round(factor)}× — stale stats or a correlation the planner can’t see often cause this`}
    >
      <AlertTriangle className="h-3 w-3" /> {word}-est {compactFactor(factor)}×
    </Badge>
  )
}

function NodeDetails({ node }: { node: PlanNode }) {
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {node.details.map((d) => (
        <div key={d.label} className="contents">
          <dt className="text-muted-foreground">{d.label}</dt>
          <dd className="break-words font-mono text-[11px] text-foreground">{d.value}</dd>
        </div>
      ))}
      {(node.rowsRemovedByFilter ?? 0) > 0 && (
        <div className="contents">
          <dt className="text-muted-foreground">Rows removed by filter</dt>
          <dd className="tabular-nums text-foreground">
            {node.rowsRemovedByFilter!.toLocaleString()}
          </dd>
        </div>
      )}
    </dl>
  )
}

// ---- Small bits -------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  )
}

type Tone = 'orange' | 'amber' | 'red' | 'muted'

const TONE_CLASS: Record<Tone, string> = {
  orange: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  amber: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  red: 'bg-red-500/15 text-red-600 dark:text-red-400',
  muted: 'bg-muted text-muted-foreground',
}

function Badge({
  children,
  tone,
  title,
}: {
  children: React.ReactNode
  tone: Tone
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  )
}

/** This node's share of the total for the chosen metric, in [0,1] or null. */
function metricShare(node: PlanNode, plan: ParsedPlan, metric: HeatMetric): number | null {
  if (metric === 'time') {
    if (node.exclusiveMs == null) return null
    const total = plan.executionMs ?? plan.root.totalMs
    if (!total || total <= 0) return null
    return node.exclusiveMs / total
  }
  if (metric === 'cost') {
    const total = plan.root.totalCost
    if (total <= 0) return null
    return node.exclusiveCost / total
  }
  return null
}

function pct(fraction: number): string {
  const p = fraction * 100
  if (p < 0.1) return '<0.1%'
  return `${p.toFixed(p < 10 ? 1 : 0)}%`
}

/** Compact a misestimate factor: 12, 340, 1.2K… */
function compactFactor(factor: number): string {
  return formatCount(Math.round(factor))
}
