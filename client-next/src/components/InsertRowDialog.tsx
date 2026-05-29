import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { Loading } from "@/components/ui/spinner";
import { detectEditorKind, type EditorKind } from "@/components/CellEditor";
import { insertRow, type ColumnMeta } from "@/lib/api";
import { previewInsert } from "@/lib/insertSql";
import { cn } from "@/lib/utils";

/**
 * Schema-generated row insert form (roadmap §4.5).
 *
 * Each column becomes a field whose widget is chosen by its Postgres type
 * (the same `detectEditorKind` the inline cell editor uses). Every field is in
 * one of three modes:
 *
 *   - **default** — the column is omitted from the INSERT so Postgres applies
 *     its DEFAULT. Only offered for default-having columns; the default
 *     expression is ghosted in the input.
 *   - **null** — the column is sent as an explicit SQL NULL. Only offered for
 *     nullable columns.
 *   - **value** — the user-entered value is coerced by type and sent.
 *
 * NOT NULL columns without a default are required: they must be in `value`
 * mode with a usable value, enforced before submit. CHECK / unique violations
 * are left to Postgres and surface in the dialog's error banner.
 *
 * Foreign-key columns fall back to a plain input with a "→ table.column" hint
 * until the FK lookup pipeline lands — graceful degradation matching §4.4.
 */

type FieldMode = "default" | "null" | "value";

interface FieldState {
  mode: FieldMode;
  /** Raw editable string. For booleans holds "true"/"false". */
  value: string;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRequired(meta: ColumnMeta): boolean {
  return meta.isNullable === false && !meta.hasDefault;
}

function initialState(
  columns: Record<string, ColumnMeta>,
): Record<string, FieldState> {
  const out: Record<string, FieldState> = {};
  for (const [name, meta] of Object.entries(columns)) {
    const kind = detectEditorKind(meta);
    out[name] = {
      // Default-having columns start ghosted; everything else starts editable.
      mode: meta.hasDefault ? "default" : "value",
      value: kind === "boolean" ? "false" : "",
    };
  }
  return out;
}

/** Coerce one value-mode field to the JSON value sent over the wire. Throws on bad input. */
function coerce(kind: EditorKind, raw: string): unknown {
  const v = raw;
  switch (kind) {
    case "boolean":
      return v === "true";
    case "number": {
      const t = v.trim();
      if (t === "") throw new Error("Enter a number");
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) {
        throw new Error("Not a number");
      }
      // Send the literal string so bigint precision survives the wire.
      return t;
    }
    case "uuid": {
      if (v === "") throw new Error("Enter a UUID");
      if (!UUID_RE.test(v)) throw new Error("Not a valid UUID");
      return v;
    }
    case "json":
    case "array": {
      if (v.trim() === "") throw new Error("Enter JSON");
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch (err) {
        throw new Error(`Invalid JSON: ${(err as Error).message}`);
      }
      if (kind === "array" && !Array.isArray(parsed)) {
        throw new Error('Array column requires a JSON array (e.g. ["a", "b"]).');
      }
      return parsed;
    }
    case "date":
    case "datetime":
      if (v === "") throw new Error("Pick a date");
      return v;
    case "text":
    default:
      return v;
  }
}

function genUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

interface InsertRowDialogProps {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  tableName: string;
  columns: Record<string, ColumnMeta>;
  /** Called after a successful insert so the caller can refetch the grid. */
  onInserted: () => void;
}

export function InsertRowDialog({
  open,
  onClose,
  connectionId,
  tableName,
  columns,
  onInserted,
}: InsertRowDialogProps) {
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showSql, setShowSql] = useState(false);

  // (Re)seed the form whenever it opens or the target table's columns change.
  useEffect(() => {
    if (!open) return;
    setFields(initialState(columns));
    setFieldErrors({});
  }, [open, columns]);

  function setField(name: string, patch: Partial<FieldState>) {
    setFields((f) => ({ ...f, [name]: { ...f[name], ...patch } }));
    if (fieldErrors[name]) {
      setFieldErrors((e) => {
        const { [name]: _drop, ...rest } = e;
        return rest;
      });
    }
  }

  /** Build the wire payload, collecting per-field coercion errors. */
  function buildValues(): { values: Record<string, unknown> } | null {
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const [name, meta] of Object.entries(columns)) {
      const state = fields[name];
      if (!state) continue;
      if (state.mode === "default") {
        if (isRequired(meta)) errors[name] = "Required — provide a value";
        continue;
      }
      if (state.mode === "null") {
        if (meta.isNullable === false) errors[name] = "Column is NOT NULL";
        else values[name] = null;
        continue;
      }
      // value mode
      const kind = detectEditorKind(meta);
      try {
        values[name] = coerce(kind, state.value);
      } catch (err) {
        errors[name] = (err as Error).message;
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return null;
    }
    return { values };
  }

  // Preview reflects only fields that would actually be sent. Mirror the
  // submit logic but skip rows that currently error so the SQL stays readable.
  const previewSql = useMemo(() => {
    if (!showSql) return "";
    const values: Record<string, unknown> = {};
    for (const [name, meta] of Object.entries(columns)) {
      const state = fields[name];
      if (!state || state.mode === "default") continue;
      if (state.mode === "null") {
        values[name] = null;
        continue;
      }
      try {
        values[name] = coerce(detectEditorKind(meta), state.value);
      } catch {
        // Skip not-yet-valid fields in the preview.
      }
    }
    return previewInsert(tableName, values, columns);
  }, [showSql, fields, columns, tableName]);

  const mutation = useMutation({
    mutationFn: (payload: { values: Record<string, unknown> }) =>
      insertRow(connectionId, tableName, payload),
  });

  function submit(keepOpen: boolean) {
    const payload = buildValues();
    if (!payload) return;
    mutation.mutate(payload, {
      onSuccess: () => {
        onInserted();
        if (keepOpen) {
          setFields(initialState(columns));
          setFieldErrors({});
        } else {
          onClose();
        }
      },
    });
  }

  const busy = mutation.isPending;
  const colEntries = Object.entries(columns);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Insert row into ${tableName}`}
      className="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            className="mr-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showSql ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            Show SQL
          </button>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => submit(true)}
            disabled={busy}
            title="Insert and keep this form open for another row"
          >
            Insert &amp; add another
          </Button>
          <Button size="sm" onClick={() => submit(false)} disabled={busy}>
            {busy ? <Loading>Inserting…</Loading> : "Insert"}
          </Button>
        </>
      }
    >
      {mutation.error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {(mutation.error as Error).message}
        </div>
      )}

      <div className="space-y-3">
        {colEntries.map(([name, meta]) => (
          <InsertField
            key={name}
            name={name}
            meta={meta}
            state={fields[name] ?? { mode: "value", value: "" }}
            error={fieldErrors[name]}
            onChange={(patch) => setField(name, patch)}
          />
        ))}
        {colEntries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No columns — this table will insert a default row.
          </p>
        )}
      </div>

      {showSql && previewSql && (
        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
          {previewSql}
        </pre>
      )}
    </Dialog>
  );
}

// ---- Per-column field ------------------------------------------------------

interface InsertFieldProps {
  name: string;
  meta: ColumnMeta;
  state: FieldState;
  error?: string;
  onChange: (patch: Partial<FieldState>) => void;
}

function InsertField({ name, meta, state, error, onChange }: InsertFieldProps) {
  const kind = detectEditorKind(meta);
  const required = isRequired(meta);
  const disabled = state.mode !== "value";

  const placeholder =
    state.mode === "default"
      ? meta.defaultValue
        ? `DEFAULT ${meta.defaultValue}`
        : "DEFAULT"
      : state.mode === "null"
        ? "NULL"
        : undefined;

  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr] items-start gap-3">
      <label className="pt-1.5 text-sm">
        <span className="font-medium">{name}</span>
        {required && <span className="text-destructive"> *</span>}
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
          <span className="font-mono">{meta.dataType}</span>
          {meta.isPrimaryKey && <Badge>PK</Badge>}
          {meta.isForeignKey && meta.foreignKeyRef && (
            <Badge title="Foreign key">
              → {meta.foreignKeyRef.table}.{meta.foreignKeyRef.column}
            </Badge>
          )}
        </span>
      </label>

      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <FieldWidget
            kind={kind}
            meta={meta}
            value={state.value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(value) => onChange({ mode: "value", value })}
          />
          {meta.hasDefault && (
            <ModeButton
              active={state.mode === "default"}
              title={meta.defaultValue ?? "Use column default"}
              // Toggle back to value mode so the input becomes editable again.
              onClick={() =>
                onChange({ mode: state.mode === "default" ? "value" : "default" })
              }
            >
              DEFAULT
            </ModeButton>
          )}
          {meta.isNullable && (
            <ModeButton
              active={state.mode === "null"}
              title="Set to SQL NULL"
              onClick={() =>
                onChange({ mode: state.mode === "null" ? "value" : "null" })
              }
            >
              ∅
            </ModeButton>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

interface WidgetProps {
  kind: EditorKind;
  meta: ColumnMeta;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}

function FieldWidget({ kind, value, disabled, placeholder, onChange }: WidgetProps) {
  if (kind === "boolean") {
    return (
      <Select
        value={disabled ? "" : value || "false"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      >
        {disabled && <option value="">{placeholder}</option>}
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  }

  if (kind === "json" || kind === "array") {
    return (
      <textarea
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? (kind === "json" ? '{ "key": "value" }' : '["a", "b"]')}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[60px] w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-50"
      />
    );
  }

  if (kind === "uuid") {
    return (
      <div className="flex w-full items-center gap-1">
        <Input
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? "00000000-0000-0000-0000-000000000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 font-mono text-xs"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(genUuid())}
          title="Generate UUID v4"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  const inputType =
    kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : "text";

  return (
    <Input
      type={inputType}
      step={kind === "datetime" ? 1 : undefined}
      inputMode={kind === "number" ? "decimal" : undefined}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 text-xs"
    />
  );
}

function ModeButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "shrink-0 rounded-md border px-1.5 py-1 text-[10px] font-medium uppercase",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Badge({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
    >
      {children}
    </span>
  );
}
