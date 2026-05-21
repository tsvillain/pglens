import { createContext, memo, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import dagre from '@dagrejs/dagre'
import {
  Background,
  ConnectionLineType,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toSvg } from 'html-to-image'
import {
  ChevronDown, Clipboard, Download, FileImage, FileType, Key,
  Link as LinkIcon, Search, Shrink,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Loading } from '@/components/ui/spinner'
import { getDatabaseSchema, type SchemaTable } from '@/lib/api'
import { toMermaidER } from '@/lib/mermaid'
import { useConnectionStore } from '@/store/connection'
import { useEffectiveTheme } from '@/store/theme'
import { cn } from '@/lib/utils'

type Direction = 'LR' | 'TB'

const COL_W = 280
const ROW_H = 22
const HEADER_H = 36

type TableNodeData = {
  table: SchemaTable
}

// Hover spotlight state lives in context, not in node data. Keeping it out of
// the nodes array means hovering doesn't rebuild node objects → ReactFlow never
// re-reconciles node DOM → mouseenter/leave don't ping-pong → no flicker.
type HoverState = {
  hoveredId: string | null
  neighbors: Map<string, Set<string>>
}
const HoverContext = createContext<HoverState>({ hoveredId: null, neighbors: new Map() })

const TableNode = memo(function TableNode({ id, data, selected }: NodeProps<Node<TableNodeData>>) {
  const { table } = data
  const { hoveredId, neighbors } = useContext(HoverContext)
  const highlight = hoveredId === id
  const dim = hoveredId !== null && !highlight && !neighbors.get(hoveredId)?.has(id)
  return (
    <div
      className={cn(
        'rounded-md border bg-card shadow-sm transition-opacity',
        selected || highlight ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        dim && 'opacity-30',
      )}
      style={{ width: COL_W }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-primary" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-primary" />
      <div className="border-b border-border bg-muted/60 px-2 py-1.5 text-xs font-semibold">
        {table.name}
      </div>
      <ul className="text-[11px]">
        {table.columns.map((c) => (
          <li
            key={c.name}
            className="flex items-center gap-1.5 border-b border-border/40 px-2 py-1 last:border-b-0"
            style={{ height: ROW_H }}
          >
            {c.isPrimaryKey && <Key className="h-3 w-3 shrink-0 text-amber-500" />}
            {c.isForeignKey && <LinkIcon className="h-3 w-3 shrink-0 text-sky-500" />}
            <span className="truncate font-mono">{c.name}</span>
            <span className="ml-auto truncate pl-2 text-muted-foreground">{c.type}</span>
          </li>
        ))}
      </ul>
    </div>
  )
})

const nodeTypes = { table: TableNode }

/**
 * Lay out the schema using dagre. Tables flow left → right with FK arrows
 * pointing toward referenced tables; vertical rank groups tables that are
 * at the same FK depth, so the resulting graph reads roughly like an ERD.
 */
function layoutDagre(
  tables: SchemaTable[],
  edges: Edge[],
  direction: Direction,
): Node<TableNodeData>[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    ranksep: direction === 'LR' ? 120 : 80,
    nodesep: direction === 'LR' ? 40 : 60,
    edgesep: 30,
    marginx: 40,
    marginy: 40,
  })

  for (const t of tables) {
    const height = HEADER_H + t.columns.length * ROW_H
    g.setNode(t.name, { width: COL_W, height })
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target)
    }
  }
  dagre.layout(g)

  return tables.map((t) => {
    const pos = g.node(t.name)
    const height = HEADER_H + t.columns.length * ROW_H
    return {
      id: t.name,
      type: 'table',
      // dagre returns center coords; React Flow expects top-left.
      position: { x: pos.x - COL_W / 2, y: pos.y - height / 2 },
      data: { table: t },
    }
  })
}

function buildEdges(tables: SchemaTable[]): Edge[] {
  const edges: Edge[] = []
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.foreignKeyRef) {
        edges.push({
          id: `${t.name}.${c.name}->${c.foreignKeyRef.table}.${c.foreignKeyRef.column}`,
          source: t.name,
          target: c.foreignKeyRef.table,
          label: c.name,
          type: 'smoothstep',
          animated: false,
          style: { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, opacity: 0.6 },
          labelStyle: { fontSize: 9, fill: 'hsl(var(--muted-foreground))' },
          labelBgStyle: { fill: 'hsl(var(--background))', fillOpacity: 0.8 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        })
      }
    }
  }
  return edges
}

function downloadBlob(content: string | Blob, fileName: string, mime?: string) {
  const blob =
    typeof content === 'string' ? new Blob([content], { type: mime ?? 'text/plain' }) : content
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function SchemaCanvas({ tables }: { tables: SchemaTable[] }) {
  const [filter, setFilter] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [direction, setDirection] = useState<Direction>('LR')
  const [copied, setCopied] = useState(false)
  const flowRef = useRef<HTMLDivElement>(null)
  const rf = useReactFlow()
  const effectiveTheme = useEffectiveTheme()

  const filteredTables = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return tables
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q)),
    )
  }, [tables, filter])

  const edges = useMemo(() => {
    const allow = new Set(filteredTables.map((t) => t.name))
    return buildEdges(filteredTables).filter(
      (e) => allow.has(e.source) && allow.has(e.target),
    )
  }, [filteredTables])

  const baseNodes = useMemo(
    () => layoutDagre(filteredTables, edges, direction),
    [filteredTables, edges, direction],
  )

  // Adjacency map: for each table, the set of directly-connected tables.
  // Built once per edge change so hovering is a cheap lookup, not a rebuild.
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const link = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set([a]))
      map.get(a)!.add(b)
    }
    for (const e of edges) {
      link(e.source, e.target)
      link(e.target, e.source)
    }
    return map
  }, [edges])

  const hoverState = useMemo<HoverState>(() => ({ hoveredId, neighbors }), [hoveredId, neighbors])

  // Hover spotlight: connected edges light up; the rest fade. Node dimming is
  // handled inside TableNode via context so the nodes array stays stable.
  const decoratedEdges = useMemo(() => {
    if (!hoveredId) return edges
    return edges.map((e) => {
      const active = e.source === hoveredId || e.target === hoveredId
      return {
        ...e,
        animated: active,
        style: {
          ...e.style,
          opacity: active ? 0.9 : 0.15,
          stroke: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
          strokeWidth: active ? 1.5 : 1,
        },
      }
    })
  }, [edges, hoveredId])

  const getViewport = useCallback(() => {
    return flowRef.current?.querySelector<HTMLElement>('.react-flow__viewport') ?? null
  }, [])

  const exportSvg = useCallback(async () => {
    const target = getViewport()
    if (!target) return
    rf.fitView({ padding: 0.2 })
    await new Promise((r) => requestAnimationFrame(r))
    try {
      const dataUrl = await toSvg(target, { backgroundColor: '#ffffff', cacheBust: true })
      // toSvg returns a data: URL; strip prefix → raw SVG so file size is sane.
      const svg = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
      downloadBlob(svg, 'pglens-schema.svg', 'image/svg+xml')
    } catch (err) {
      console.error('SVG export failed', err)
    }
  }, [rf, getViewport])

  const mermaidText = useMemo(() => toMermaidER(filteredTables), [filteredTables])

  const copyMermaid = useCallback(async () => {
    const ok = await copyToClipboard(mermaidText)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [mermaidText])

  const downloadMermaid = useCallback(() => {
    downloadBlob(mermaidText, 'pglens-schema.mmd', 'text/plain')
  }, [mermaidText])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Schema</h1>
          <p className="text-xs text-muted-foreground">
            {filteredTables.length} of {tables.length} tables · {edges.length} relations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables or columns…"
              className="h-8 w-64 pl-7 text-sm"
            />
          </div>
          <div className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
            {(['LR', 'TB'] as Direction[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={cn(
                  'rounded px-2 py-1',
                  direction === d && 'bg-card shadow-sm',
                )}
                title={d === 'LR' ? 'Left → Right' : 'Top → Bottom'}
              >
                {d}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => rf.fitView({ padding: 0.2 })}>
            <Shrink className="h-3.5 w-3.5" />
            Fit
          </Button>
          <Dropdown
            trigger={() => (
              <span className="inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent">
                <Download className="h-3.5 w-3.5" />
                Export
                <ChevronDown className="h-3 w-3 opacity-60" />
              </span>
            )}
          >
            <DropdownItem icon={FileImage} onClick={exportSvg}>
              SVG (vector)
            </DropdownItem>
            <div className="my-1 border-t border-border" />
            <DropdownItem icon={Clipboard} onClick={copyMermaid}>
              {copied ? 'Copied!' : 'Copy Mermaid ER'}
            </DropdownItem>
            <DropdownItem icon={FileType} onClick={downloadMermaid}>
              Download .mmd
            </DropdownItem>
          </Dropdown>
        </div>
      </header>
      <div className="min-h-0 flex-1" ref={flowRef}>
        <HoverContext.Provider value={hoverState}>
        <ReactFlow
          nodes={baseNodes}
          edges={decoratedEdges}
          nodeTypes={nodeTypes}
          colorMode={effectiveTheme}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.1}
          maxZoom={2.5}
          connectionLineType={ConnectionLineType.SmoothStep}
          proOptions={{ hideAttribution: true }}
          onNodeMouseEnter={(_, n) => setHoveredId(n.id)}
          onNodeMouseLeave={() => setHoveredId(null)}
          nodesDraggable
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeBorderRadius={4}
            nodeStrokeWidth={2}
            nodeColor={(node) => {
              if (node.id === hoveredId) return '#0ea5e9' // sky-500
              return effectiveTheme === 'dark' ? '#7c91ad' : '#94a3b8'
            }}
            nodeStrokeColor={(node) => {
              if (node.id === hoveredId) return '#0ea5e9'
              return effectiveTheme === 'dark' ? '#475569' : '#64748b'
            }}
            maskColor={effectiveTheme === 'dark' ? 'rgba(15,23,42,0.6)' : 'rgba(248,250,252,0.6)'}
            maskStrokeColor={effectiveTheme === 'dark' ? '#94a3b8' : '#475569'}
            maskStrokeWidth={3}
            style={{
              width: 240,
              height: 180,
              background: effectiveTheme === 'dark' ? '#1e293b' : '#f8fafc',
              border: '1px solid',
              borderColor: effectiveTheme === 'dark' ? '#334155' : '#e2e8f0',
              borderRadius: 6,
            }}
          />
        </ReactFlow>
        </HoverContext.Provider>
      </div>
    </div>
  )
}

export function SchemaViz() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const query = useQuery({
    queryKey: ['schema', connectionId],
    queryFn: ({ signal }) =>
      getDatabaseSchema(connectionId!, signal).then((r) => r.schema),
    enabled: !!connectionId,
  })

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  if (query.error) {
    return (
      <div className="m-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        {(query.error as Error).message}
      </div>
    )
  }

  if (query.isLoading || !query.data) {
    return (
      <Loading className="px-10 py-10 text-sm text-muted-foreground">
        Loading schema…
      </Loading>
    )
  }

  const tables = Object.values(query.data)
  return (
    <ReactFlowProvider>
      <SchemaCanvas tables={tables} />
    </ReactFlowProvider>
  )
}
