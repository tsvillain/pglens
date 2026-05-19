import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Key, Link as LinkIcon } from 'lucide-react'

import { getDatabaseSchema, type SchemaTable } from '@/lib/api'
import { useConnectionStore } from '@/store/connection'
import { cn } from '@/lib/utils'

const COL_W = 280
const ROW_H = 22
const HEADER_H = 36
const PAD_X = 60
const PAD_Y = 40

type TableNodeData = { table: SchemaTable }

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { table } = data
  return (
    <div
      className="rounded-md border border-border bg-card shadow-sm"
      style={{ width: COL_W }}
    >
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      <Handle type="source" position={Position.Right} className="!bg-primary" />
      <div className="border-b border-border bg-muted/60 px-2 py-1.5 text-xs font-semibold">
        {table.name}
      </div>
      <ul className="text-[11px]">
        {table.columns.map((c) => (
          <li
            key={c.name}
            className={cn(
              'flex items-center gap-1.5 border-b border-border/40 px-2 py-1 last:border-b-0',
            )}
            style={{ height: ROW_H }}
          >
            {c.isPrimaryKey && <Key className="h-3 w-3 text-amber-500" />}
            {c.isForeignKey && <LinkIcon className="h-3 w-3 text-sky-500" />}
            <span className="truncate font-mono">{c.name}</span>
            <span className="ml-auto truncate text-muted-foreground">
              {c.type}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const nodeTypes = { table: TableNode }

function layoutGrid(tables: SchemaTable[]): Node<TableNodeData>[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)))
  return tables.map((t, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const height = HEADER_H + t.columns.length * ROW_H
    return {
      id: t.name,
      type: 'table',
      position: { x: col * (COL_W + PAD_X), y: row * (height + PAD_Y) },
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
          style: { stroke: 'hsl(var(--primary))', strokeWidth: 1.2 },
          labelStyle: { fontSize: 10 },
        })
      }
    }
  }
  return edges
}

export function SchemaViz() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)

  const query = useQuery({
    queryKey: ['schema', connectionId],
    queryFn: ({ signal }) =>
      getDatabaseSchema(connectionId!, signal).then((r) => r.schema),
    enabled: !!connectionId,
  })

  const { nodes, edges } = useMemo(() => {
    if (!query.data) return { nodes: [], edges: [] }
    const tables = Object.values(query.data)
    return { nodes: layoutGrid(tables), edges: buildEdges(tables) }
  }, [query.data])

  if (!connectionId) {
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Schema</h1>
          <p className="text-xs text-muted-foreground">
            {query.data
              ? `${Object.keys(query.data).length} tables`
              : query.isLoading
                ? 'Loading…'
                : ''}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {query.error && (
          <div className="m-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {(query.error as Error).message}
          </div>
        )}
        {query.data && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
