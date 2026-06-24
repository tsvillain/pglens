import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ChevronDown,
  KeyRound,
  Link as LinkIcon,
  Network,
  Play,
  Plus,
  Shrink,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/CopyButton";
import { Loading } from "@/components/ui/spinner";
import {
  generateSchemaDdl,
  getDatabaseSchema,
  type Migration,
  type SchemaColumn,
  type SchemaEditOp,
  type SchemaTable,
} from "@/lib/api";
import { useConnectionStore } from "@/store/connection";
import { useEffectiveTheme } from "@/store/theme";
import { useQuerySeedStore } from "@/store/querySeed";
import { useTabsStore } from "@/store/tabs";
import { cn } from "@/lib/utils";

const COL_W = 280;
const ROW_H = 24;
const HEADER_H = 38;

// Common Postgres types offered as a native <datalist>; the field is free-text,
// so anything the server's type allowlist accepts still works.
const PG_TYPES = [
  "text",
  "varchar",
  "varchar(255)",
  "integer",
  "bigint",
  "smallint",
  "boolean",
  "numeric",
  "numeric(10,2)",
  "real",
  "double precision",
  "uuid",
  "date",
  "timestamp",
  "timestamptz",
  "time",
  "jsonb",
  "json",
  "bytea",
  "inet",
  "text[]",
];

// --- pending-op identity: one op per target, so re-editing replaces ----------

function opKey(op: SchemaEditOp): string {
  switch (op.op) {
    case "add_column":
      return `add:${op.table}.${op.column.name}`;
    case "alter_column":
      return `alter:${op.table}.${op.name}`;
    case "drop_column":
      return `drop:${op.table}.${op.name}`;
    case "add_foreign_key":
      return `fk:${op.table}.${op.column}`;
    case "drop_foreign_key":
      return `dropfk:${op.table}.${op.name}`;
  }
}

function opLabel(op: SchemaEditOp): string {
  switch (op.op) {
    case "add_column":
      return `+ ${op.table}.${op.column.name} ${op.column.type}`;
    case "alter_column": {
      const bits = [
        op.rename && `rename → ${op.rename}`,
        op.type && `type → ${op.type}`,
        op.notNull != null && (op.notNull ? "SET NOT NULL" : "DROP NOT NULL"),
        op.default !== undefined &&
          (op.default === null ? "DROP DEFAULT" : `DEFAULT ${op.default}`),
      ].filter(Boolean);
      return `~ ${op.table}.${op.name}: ${bits.join(", ") || "no change"}`;
    }
    case "drop_column":
      return `− ${op.table}.${op.name}`;
    case "add_foreign_key":
      return `→ ${op.table}.${op.column} references ${op.refTable}.${op.refColumn}`;
    case "drop_foreign_key":
      return `✕ FK ${op.name} on ${op.table}`;
  }
}

// Apply pending ops to the fetched schema so the canvas shows the edited state.
function applyOps(tables: SchemaTable[], ops: SchemaEditOp[]): SchemaTable[] {
  const map = new Map(
    tables.map((t) => [
      t.name,
      { ...t, columns: t.columns.map((c) => ({ ...c })) },
    ]),
  );
  for (const op of ops) {
    const t = map.get(op.table);
    if (!t) continue;
    if (op.op === "add_column") {
      if (!t.columns.some((c) => c.name === op.column.name)) {
        t.columns.push({
          name: op.column.name,
          type: op.column.type,
          maxLength: null,
          isNullable: !op.column.notNull,
          isPrimaryKey: false,
          isUnique: false,
          isForeignKey: false,
          foreignKeyRef: null,
        });
      }
    } else if (op.op === "alter_column") {
      const c = t.columns.find((x) => x.name === op.name);
      if (c) {
        if (op.type != null) c.type = op.type;
        if (op.notNull != null) c.isNullable = !op.notNull;
        if (op.rename) c.name = op.rename;
      }
    } else if (op.op === "drop_column") {
      t.columns = t.columns.filter((c) => c.name !== op.name);
    } else if (op.op === "add_foreign_key") {
      const c = t.columns.find((x) => x.name === op.column);
      if (c) {
        c.isForeignKey = true;
        c.foreignKeyRef = { table: op.refTable, column: op.refColumn };
      }
    } else if (op.op === "drop_foreign_key") {
      const c = t.columns.find((x) => x.foreignKeyRef?.name === op.name);
      if (c) {
        c.isForeignKey = false;
        c.foreignKeyRef = null;
      }
    }
  }
  return [...map.values()];
}

// --- editable table node -----------------------------------------------------

type TableNodeData = {
  table: SchemaTable;
  pendingCols: Set<string>;
  onAddColumn: (t: string) => void;
  onEditColumn: (t: string, c: string) => void;
};

const TableNode = memo(function TableNode({
  data,
}: NodeProps<Node<TableNodeData>>) {
  const { table, pendingCols, onAddColumn, onEditColumn } = data;
  return (
    <div
      className="rounded-md border border-border bg-card shadow-sm"
      style={{ width: COL_W }}
    >
      <div
        className="flex items-center gap-1 border-b border-border bg-muted/60 px-2 py-1.5 text-xs font-semibold"
        style={{ height: HEADER_H }}
      >
        <span className="truncate">{table.name}</span>
        <button
          type="button"
          onClick={() => onAddColumn(table.name)}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Add column"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="text-[11px]">
        {table.columns.map((c) => {
          // Pending (just-added) columns aren't re-editable — they have no DB
          // original to alter against; remove from the list + re-add to change.
          const pending = pendingCols.has(c.name);
          return (
            // `relative` so each row's handles center on the row (React Flow's
            // default Left/Right handle is top:50% of its positioned parent).
            <li
              key={c.name}
              onClick={
                pending ? undefined : () => onEditColumn(table.name, c.name)
              }
              className={cn(
                "relative flex items-center gap-1.5 border-b border-border/40 px-2 last:border-b-0",
                pending
                  ? "cursor-default bg-emerald-500/10"
                  : "cursor-pointer hover:bg-accent/50",
              )}
              style={{ height: ROW_H }}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={c.name}
                className="!h-2 !w-2 !border !border-background !bg-sky-500"
              />
              {c.isPrimaryKey && (
                <KeyRound className="h-3 w-3 shrink-0 text-amber-500" />
              )}
              {c.isForeignKey && (
                <LinkIcon className="h-3 w-3 shrink-0 text-sky-500" />
              )}
              <span className="truncate font-mono">{c.name}</span>
              <span className="ml-auto truncate pl-2 text-muted-foreground">
                {c.type}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={c.name}
                className="!h-2 !w-2 !border !border-background !bg-primary"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
});

const nodeTypes = { table: TableNode };

function layout(
  tables: SchemaTable[],
  edges: Edge[],
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    ranksep: 120,
    nodesep: 40,
    marginx: 40,
    marginy: 40,
  });
  for (const t of tables) {
    g.setNode(t.name, {
      width: COL_W,
      height: HEADER_H + t.columns.length * ROW_H,
    });
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target))
      g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const t of tables) {
    const n = g.node(t.name);
    out[t.name] = {
      x: n.x - COL_W / 2,
      y: n.y - (HEADER_H + t.columns.length * ROW_H) / 2,
    };
  }
  return out;
}

function buildEdges(tables: SchemaTable[], pendingFk: Set<string>): Edge[] {
  const edges: Edge[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.foreignKeyRef) continue;
      const pending = pendingFk.has(`${t.name}.${c.name}`);
      edges.push({
        id: `${t.name}.${c.name}->${c.foreignKeyRef.table}.${c.foreignKeyRef.column}`,
        source: t.name,
        sourceHandle: c.name,
        target: c.foreignKeyRef.table,
        targetHandle: c.foreignKeyRef.column,
        type: "smoothstep",
        animated: pending,
        style: {
          stroke: pending
            ? "hsl(var(--primary))"
            : "hsl(var(--muted-foreground))",
          strokeWidth: pending ? 1.8 : 1,
          strokeDasharray: pending ? "5 4" : undefined,
          opacity: pending ? 1 : 0.6,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      });
    }
  }
  return edges;
}

// --- canvas ------------------------------------------------------------------

function ErdCanvas({
  tables,
  connectionId,
}: {
  tables: SchemaTable[];
  connectionId: string;
}) {
  const [ops, setOps] = useState<SchemaEditOp[]>([]);
  const [editing, setEditing] = useState<{
    table: string;
    column: string | null;
  } | null>(null);
  const [ddl, setDdl] = useState<Migration | null>(null);
  const [ddlError, setDdlError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const rf = useReactFlow();
  const theme = useEffectiveTheme();
  const navigate = useNavigate();

  const draft = useMemo(() => applyOps(tables, ops), [tables, ops]);

  const pendingFk = useMemo(
    () =>
      new Set(
        ops
          .filter((o) => o.op === "add_foreign_key")
          .map((o) => `${o.table}.${o.column}`),
      ),
    [ops],
  );
  const pendingColsByTable = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const o of ops) {
      if (o.op === "add_column")
        (m.get(o.table) ?? m.set(o.table, new Set()).get(o.table)!).add(
          o.column.name,
        );
    }
    return m;
  }, [ops]);

  const draftByName = useMemo(
    () => new Map(draft.map((t) => [t.name, t])),
    [draft],
  );
  const edges = useMemo(() => buildEdges(draft, pendingFk), [draft, pendingFk]);

  // React Flow owns node positions (so dragging is smooth) via useNodesState.
  // Seeded once with a dagre layout; column edits patch node *data* in place
  // (below) and Auto-layout re-runs dagre — neither resets manual drags.
  const handlers = useMemo(
    () => ({
      onAddColumn: (tbl: string) => setEditing({ table: tbl, column: null }),
      onEditColumn: (tbl: string, col: string) =>
        setEditing({ table: tbl, column: col }),
    }),
    [],
  );
  const initialNodes = useMemo<Node<TableNodeData>[]>(() => {
    const pos = layout(tables, buildEdges(tables, new Set()));
    return tables.map((t) => ({
      id: t.name,
      type: "table",
      position: pos[t.name] ?? { x: 0, y: 0 },
      data: { table: t, pendingCols: new Set<string>(), ...handlers },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [nodes, setNodes, onNodesChange] =
    useNodesState<Node<TableNodeData>>(initialNodes);

  // Reflect pending column/FK edits into node data without moving the node.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const t = draftByName.get(n.id);
        return t
          ? {
              ...n,
              data: {
                ...n.data,
                table: t,
                pendingCols: pendingColsByTable.get(n.id) ?? new Set(),
              },
            }
          : n;
      }),
    );
  }, [draftByName, pendingColsByTable, setNodes]);

  const relayout = useCallback(() => {
    const pos = layout(draft, edges);
    setNodes((nds) =>
      nds.map((n) => ({ ...n, position: pos[n.id] ?? n.position })),
    );
  }, [draft, edges, setNodes]);

  const upsertOp = useCallback((op: SchemaEditOp) => {
    setOps((prev) => [...prev.filter((o) => opKey(o) !== opKey(op)), op]);
  }, []);
  const removeOp = useCallback((key: string) => {
    setOps((prev) => prev.filter((o) => opKey(o) !== key));
  }, []);

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (!c.source || !c.target || !c.sourceHandle) return;
      // Drop on a specific column handle, else default to the target's PK.
      const refTable = draft.find((t) => t.name === c.target);
      const refColumn =
        c.targetHandle || refTable?.columns.find((x) => x.isPrimaryKey)?.name;
      if (!refColumn) return;
      upsertOp({
        op: "add_foreign_key",
        table: c.source,
        column: c.sourceHandle,
        refTable: c.target,
        refColumn,
      });
    },
    [draft, upsertOp],
  );

  // Click a relation to remove it: a just-added (pending) FK drops its op; an
  // existing DB FK stages a drop_foreign_key (reversible from the list). Both
  // are review-only — the DROP CONSTRAINT runs only from the editor.
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      const table = edge.source;
      const column = edge.sourceHandle;
      if (!column) return;
      if (pendingFk.has(`${table}.${column}`)) {
        removeOp(`fk:${table}.${column}`);
        return;
      }
      const name = tables
        .find((t) => t.name === table)
        ?.columns.find((c) => c.name === column)?.foreignKeyRef?.name;
      if (name) upsertOp({ op: "drop_foreign_key", table, name });
    },
    [pendingFk, tables, removeOp, upsertOp],
  );

  const generate = useCallback(async () => {
    setGenerating(true);
    setDdlError(null);
    try {
      setDdl(await generateSchemaDdl(connectionId, ops));
    } catch (err) {
      setDdlError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [connectionId, ops]);

  const script = useMemo(
    () => ddl?.statements.map((s) => s.sql).join("\n") ?? "",
    [ddl],
  );
  const openInEditor = useCallback(() => {
    useQuerySeedStore.getState().setSeed(script);
    useTabsStore.getState().open({ kind: "query" });
    navigate({ to: "/query" });
  }, [script, navigate]);

  const editTable = editing
    ? draft.find((t) => t.name === editing.table)
    : null;
  const editColumn =
    editTable && editing?.column
      ? (editTable.columns.find((c) => c.name === editing.column) ?? null)
      : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div>
            <h1 className="text-lg font-semibold">ERD editor</h1>
            <p className="text-xs text-muted-foreground">
              Drag a column handle onto another to add a foreign key · click a
              relation to remove it · click a column to edit · generated SQL is
              never run for you
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={relayout}>
              <Network className="h-3.5 w-3.5" />
              Auto-layout
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => rf.fitView({ padding: 0.2 })}
            >
              <Shrink className="h-3.5 w-3.5" />
              Fit
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={theme}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgeClick={onEdgeClick}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
            minZoom={0.1}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      {/* Right rail: column editor (top) + pending changes / SQL review (bottom) */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border">
        <div className="min-h-0 flex-1 overflow-auto">
          {editTable ? (
            <ColumnEditor
              key={`${editing!.table}:${editing!.column ?? "+"}`}
              table={editTable.name}
              column={editColumn}
              original={
                tables
                  .find((t) => t.name === editing!.table)
                  ?.columns.find((c) => c.name === editing!.column) ?? null
              }
              onCancel={() => setEditing(null)}
              onSubmit={(op) => {
                upsertOp(op);
                setEditing(null);
              }}
              onDrop={
                editColumn
                  ? () => {
                      upsertOp({
                        op: "drop_column",
                        table: editTable.name,
                        name: editColumn.name,
                      });
                      setEditing(null);
                    }
                  : undefined
              }
            />
          ) : (
            <p className="p-4 text-xs text-muted-foreground">
              Select a column to edit, or use the{" "}
              <Plus className="inline h-3 w-3" /> on a table to add one.
            </p>
          )}
        </div>

        <div className="flex max-h-[55%] flex-col border-t border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold">
              Pending changes · {ops.length}
            </h2>
            {ops.length > 0 && (
              <button
                onClick={() => {
                  setOps([]);
                  setDdl(null);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 py-2 text-xs">
            {ops.length === 0 ? (
              <p className="px-2 py-3 text-muted-foreground">No changes yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {ops.map((op) => (
                  <li
                    key={opKey(op)}
                    className="flex items-center gap-1 rounded px-2 py-1 font-mono hover:bg-accent/50"
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={opLabel(op)}
                    >
                      {opLabel(op)}
                    </span>
                    <button
                      onClick={() => removeOp(opKey(op))}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-border p-2">
            <Button
              size="sm"
              className="w-full"
              disabled={ops.length === 0 || generating}
              onClick={generate}
            >
              {generating ? "Generating…" : "Generate SQL"}
            </Button>
          </div>
        </div>
      </aside>

      {ddl && (
        <DdlDialog
          ddl={ddl}
          script={script}
          onClose={() => setDdl(null)}
          onOpenInEditor={openInEditor}
        />
      )}
      {ddlError && (
        <DdlDialog error={ddlError} onClose={() => setDdlError(null)} />
      )}
    </div>
  );
}

// --- column editor form ------------------------------------------------------

function ColumnEditor({
  table,
  column,
  original,
  onSubmit,
  onCancel,
  onDrop,
}: {
  table: string;
  column: SchemaColumn | null; // current (draft) column, null = adding
  original: SchemaColumn | null; // DB original, for diffing an alter
  onSubmit: (op: SchemaEditOp) => void;
  onCancel: () => void;
  onDrop?: () => void;
}) {
  const adding = !column;
  const [name, setName] = useState(column?.name ?? "");
  const [type, setType] = useState(column?.type ?? "text");
  const [notNull, setNotNull] = useState(column ? !column.isNullable : false);
  const [def, setDef] = useState("");

  const submit = () => {
    if (!name.trim() || !type.trim()) return;
    const defaultExpr = def.trim() || undefined;
    if (adding) {
      onSubmit({
        op: "add_column",
        table,
        column: {
          name: name.trim(),
          type: type.trim(),
          notNull,
          default: defaultExpr,
        },
      });
      return;
    }
    // Alter: only the fields that differ from the DB original. Rename is
    // deferred (it would mutate the column's identity and break re-editing) —
    // the backend supports it; the UI just keeps the name read-only for now.
    // ponytail: a non-empty Default emits SET DEFAULT; DROP DEFAULT isn't
    // surfaced (the schema endpoint doesn't return the current default to diff
    // against) — add it if it's ever asked for.
    const base = original ?? column!;
    const op: SchemaEditOp = { op: "alter_column", table, name: base.name };
    if (type.trim() !== base.type) op.type = type.trim();
    if (notNull !== !base.isNullable) op.notNull = notNull;
    if (defaultExpr) op.default = defaultExpr;
    onSubmit(op);
  };

  return (
    <div className="p-4">
      <h2 className="mb-3 text-sm font-semibold">
        {adding ? "Add column" : "Edit column"}{" "}
        <span className="font-mono text-muted-foreground">· {table}</span>
      </h2>
      <label className="mb-2 block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Name
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={!adding}
          className={cn("h-8 font-mono text-sm", !adding && "opacity-60")}
          autoFocus={adding}
        />
      </label>
      <label className="mb-2 block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Type
        </span>
        <div className="flex items-center gap-1">
          <Input
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-8 flex-1 font-mono text-sm"
          />
          <Dropdown
            align="end"
            className="max-h-64 overflow-auto"
            trigger={() => (
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background hover:bg-accent"
                title="Pick a type"
              >
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </span>
            )}
          >
            {PG_TYPES.map((t) => (
              <DropdownItem key={t} onClick={() => setType(t)}>
                {t}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      </label>
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={notNull}
          onChange={(e) => setNotNull(e.target.checked)}
        />
        NOT NULL
      </label>
      <label className="mb-1 block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Default
        </span>
        <Input
          value={def}
          onChange={(e) => setDef(e.target.value)}
          placeholder="e.g. false · 0 · now() · 'active'"
          className="h-8 font-mono text-sm"
        />
      </label>
      {adding && notNull && !def.trim() && (
        <p className="mb-3 text-[11px] text-amber-600 dark:text-amber-400">
          A NOT NULL column on a table with existing rows needs a default, or
          the migration fails.
        </p>
      )}
      <div
        className={cn(
          "flex items-center gap-2",
          !(adding && notNull && !def.trim()) && "mt-3",
        )}
      >
        <Button size="sm" onClick={submit}>
          {adding ? "Add" : "Stage change"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {onDrop && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            onClick={onDrop}
            title="Drop column"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// --- DDL review dialog -------------------------------------------------------

function DdlDialog({
  ddl,
  script,
  error,
  onClose,
  onOpenInEditor,
}: {
  ddl?: Migration;
  script?: string;
  error?: string;
  onClose: () => void;
  onOpenInEditor?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Review migration SQL</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {error ? (
          <p className="px-4 py-6 text-sm text-destructive">{error}</p>
        ) : (
          <>
            {ddl!.hasDestructive && (
              <div className="flex items-start gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Contains destructive operations (highlighted) — review before
                  running.
                </span>
              </div>
            )}
            <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs leading-relaxed">
              {ddl!.statements.map((s, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap font-mono",
                    s.destructive && "text-destructive",
                  )}
                >
                  {s.sql}
                </div>
              ))}
            </pre>
            <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
              <CopyButton text={script!} />
              <Button size="sm" onClick={onOpenInEditor} disabled={!script}>
                <Play className="h-3.5 w-3.5" />
                Open in editor
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

export function ErdEditor() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId);
  const query = useQuery({
    queryKey: ["schema", connectionId],
    queryFn: ({ signal }) =>
      getDatabaseSchema(connectionId!, signal).then((r) => r.schema),
    enabled: !!connectionId,
  });

  if (!connectionId)
    return (
      <div className="px-10 py-10 text-sm text-muted-foreground">
        No active connection.
      </div>
    );
  if (query.error) {
    return (
      <div className="m-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        {(query.error as Error).message}
      </div>
    );
  }
  if (query.isLoading || !query.data)
    return (
      <Loading className="px-10 py-10 text-sm text-muted-foreground">
        Loading schema…
      </Loading>
    );

  return (
    <ReactFlowProvider>
      <ErdCanvas
        tables={Object.values(query.data)}
        connectionId={connectionId}
      />
    </ReactFlowProvider>
  );
}
