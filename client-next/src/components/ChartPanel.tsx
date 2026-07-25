import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Select } from '@/components/ui/select'
import {
  classifyColumns,
  suggestCharts,
  type ChartType,
} from '@/lib/chartSuggest'

/**
 * Chart panel (roadmap §7.5). Renders the rows in hand as a line / bar / scatter
 * chart, auto-suggesting a type and axes from the column types. The user can
 * override the type and either axis. Plots client-side from the result already
 * loaded — no re-query — so it works for both raw query results and no-code
 * table pages.
 *
 * Saving a chart as part of a view (also §7.5) is not wired yet — views persist
 * column widths / filters / sort, not chart config.
 */

// ponytail: cap plotted points; SVG charts choke past a few thousand and the
// shape is unreadable anyway. Raise / add downsampling if real use needs more.
const MAX_POINTS = 500

const ACCENT = 'hsl(221 83% 53%)' // blue-600, readable on light + dark

type Row = Record<string, unknown>

export function ChartPanel({
  rows,
  columns,
}: {
  rows: Row[]
  columns: { name: string; type: string }[]
}) {
  const cols = useMemo(() => classifyColumns(columns, rows), [columns, rows])
  const suggestions = useMemo(() => suggestCharts(cols), [cols])
  const first = suggestions[0]

  const [type, setType] = useState<ChartType>(first?.type ?? 'bar')
  const [x, setX] = useState(first?.x ?? columns[0]?.name ?? '')
  const [y, setY] = useState(first?.y ?? columns[0]?.name ?? '')

  // Build the plot data: numeric y (drop unparseable), numeric x for scatter.
  const data = useMemo(() => {
    const out: { x: unknown; y: number }[] = []
    for (const r of rows) {
      const yv = Number(r[y])
      if (!Number.isFinite(yv)) continue
      const xv = type === 'scatter' ? Number(r[x]) : r[x]
      if (type === 'scatter' && !Number.isFinite(xv as number)) continue
      out.push({ x: xv, y: yv })
      if (out.length >= MAX_POINTS) break
    }
    return out
  }, [rows, x, y, type])

  if (columns.length === 0 || rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No rows to chart.</p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-end gap-3">
        <Field label="Chart">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as ChartType)}
          >
            <option value="line">Line</option>
            <option value="bar">Bar</option>
            <option value="scatter">Scatter</option>
          </Select>
        </Field>
        <Field label="X axis">
          <ColSelect value={x} columns={columns} onChange={setX} />
        </Field>
        <Field label="Y axis">
          <ColSelect value={y} columns={columns} onChange={setY} />
        </Field>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {suggestions.map((s) => (
              <button
                key={s.label}
                onClick={() => {
                  setType(s.type)
                  setX(s.x)
                  setY(s.y)
                }}
                className="rounded border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                title="Apply suggested chart"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Pick a numeric Y column to chart.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {renderChart(type, data)}
          </ResponsiveContainer>
        )}
      </div>
      {data.length >= MAX_POINTS && (
        <p className="shrink-0 text-xs text-muted-foreground">
          Showing first {MAX_POINTS} points.
        </p>
      )}
    </div>
  )
}

function renderChart(type: ChartType, data: { x: unknown; y: number }[]) {
  const grid = (
    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
  )
  const axes = (
    <>
      <XAxis
        dataKey="x"
        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
        type={type === 'scatter' ? 'number' : 'category'}
      />
      <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
      <Tooltip
        contentStyle={{
          background: 'hsl(var(--card))',
          border: '1px solid hsl(var(--border))',
          borderRadius: 6,
          fontSize: 12,
        }}
      />
    </>
  )
  if (type === 'line') {
    return (
      <LineChart data={data}>
        {grid}
        {axes}
        <Line type="monotone" dataKey="y" stroke={ACCENT} dot={false} />
      </LineChart>
    )
  }
  if (type === 'scatter') {
    return (
      <ScatterChart>
        {grid}
        {axes}
        <Scatter data={data} fill={ACCENT} />
      </ScatterChart>
    )
  }
  return (
    <BarChart data={data}>
      {grid}
      {axes}
      <Bar dataKey="y" fill={ACCENT} />
    </BarChart>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <div className="w-40">{children}</div>
    </label>
  )
}

function ColSelect({
  value,
  columns,
  onChange,
}: {
  value: string
  columns: { name: string; type: string }[]
  onChange: (v: string) => void
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </Select>
  )
}
