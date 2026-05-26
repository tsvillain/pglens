import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Sparkles, X } from "lucide-react";

import type { ColumnMeta } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Type-aware inline cell editor.
 *
 * Two surface modes:
 *   - **inline** — the editor renders in place of the cell content. Used for
 *     boolean/number/date/uuid/text/varchar. Commit on Enter or blur, cancel
 *     on Esc, NULL via the dropdown menu where the type allows it.
 *   - **dialog** — large or structured values (json/jsonb, arrays) open a
 *     modal with a textarea + validation. The cell shows a "..." launcher
 *     while the dialog is open.
 *
 * Foreign-key and enum columns fall back to a plain text input until their
 * lookup pipelines land — graceful degradation per roadmap §4.4.
 */

export type EditorKind =
  | "boolean"
  | "date"
  | "datetime"
  | "json"
  | "array"
  | "number"
  | "uuid"
  | "text";

export function detectEditorKind(meta: ColumnMeta): EditorKind {
  const t = (meta.dataType || "").toLowerCase();
  const u = (meta.udtName || "").toLowerCase();
  if (t === "boolean") return "boolean";
  if (t === "json" || t === "jsonb") return "json";
  if (t === "array" || u.startsWith("_")) return "array";
  if (t === "date") return "date";
  if (t.startsWith("timestamp")) return "datetime";
  if (t === "uuid") return "uuid";
  if (
    t === "integer" ||
    t === "bigint" ||
    t === "smallint" ||
    t === "numeric" ||
    t === "real" ||
    t === "double precision" ||
    t.startsWith("decimal")
  ) {
    return "number";
  }
  return "text";
}

/** Format a row value into the string the inline editor starts with. */
function toEditableString(value: unknown, kind: EditorKind): string {
  if (value === null || value === undefined) return "";
  if (kind === "datetime") {
    // <input type="datetime-local"> wants `YYYY-MM-DDTHH:MM[:SS]` with no
    // trailing Z. Drop the timezone — the backend stores the user's intended
    // wall-clock value and Postgres re-applies session timezone.
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }
  if (kind === "date") {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface CellEditorProps {
  meta: ColumnMeta;
  value: unknown;
  onCommit: (next: unknown) => void;
  onCancel: () => void;
}

export function CellEditor(props: CellEditorProps) {
  const kind = useMemo(() => detectEditorKind(props.meta), [props.meta]);
  switch (kind) {
    case "boolean":
      return <BooleanEditor {...props} />;
    case "json":
      return <JsonArrayDialog {...props} kind="json" />;
    case "array":
      return <JsonArrayDialog {...props} kind="array" />;
    case "uuid":
      return <UuidEditor {...props} />;
    case "number":
      return <NumberEditor {...props} />;
    case "date":
      return <DateEditor {...props} mode="date" />;
    case "datetime":
      return <DateEditor {...props} mode="datetime" />;
    case "text":
    default:
      return <TextEditor {...props} />;
  }
}

// ---- Common building blocks -----------------------------------------------

interface InlineWrapperProps {
  children: React.ReactNode;
  className?: string;
}

function InlineWrapper({ children, className }: InlineWrapperProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-sm bg-background ring-2 ring-primary",
        className,
      )}
    >
      {children}
    </div>
  );
}

const baseInputCls =
  "h-7 min-w-0 flex-1 rounded-sm border-none bg-transparent px-1 text-xs font-mono outline-none";

// ---- Inline editors --------------------------------------------------------

function TextEditor({ meta, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => toEditableString(value, "text"));

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    // Preserve the original NULL when the user opens the editor on a NULL
    // cell and presses Enter without typing — otherwise empty string is the
    // user's actual choice and we send it.
    if (value === null && text === "") {
      onCancel();
      return;
    }
    onCommit(text);
  }

  return (
    <InlineWrapper>
      <input
        ref={ref}
        className={baseInputCls}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {meta.isNullable && <NullAction onClick={() => onCommit(null)} />}
    </InlineWrapper>
  );
}

function NumberEditor({ meta, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => toEditableString(value, "number"));
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    if (text === "") {
      if (value === null) return onCancel();
      if (meta.isNullable) return onCommit(null);
      setError("Required");
      return;
    }
    // Send the trimmed string so bigint precision is preserved across the
    // wire; the server's `postgres` driver parses the literal directly.
    const trimmed = text.trim();
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) {
      setError("Not a number");
      return;
    }
    onCommit(trimmed);
  }

  return (
    <InlineWrapper className={error ? "ring-destructive" : undefined}>
      <input
        ref={ref}
        inputMode="decimal"
        className={baseInputCls}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {meta.isNullable && <NullAction onClick={() => onCommit(null)} />}
    </InlineWrapper>
  );
}

function DateEditor({
  meta,
  value,
  onCommit,
  onCancel,
  mode,
}: CellEditorProps & { mode: "date" | "datetime" }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() =>
    toEditableString(value, mode === "date" ? "date" : "datetime"),
  );

  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  function commit() {
    if (text === "") {
      if (value === null) return onCancel();
      if (meta.isNullable) return onCommit(null);
      return onCancel();
    }
    onCommit(text);
  }

  return (
    <InlineWrapper>
      <input
        ref={ref}
        type={mode === "date" ? "date" : "datetime-local"}
        step={mode === "datetime" ? 1 : undefined}
        className={baseInputCls}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {meta.isNullable && <NullAction onClick={() => onCommit(null)} />}
    </InlineWrapper>
  );
}

function BooleanEditor({ meta, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLSelectElement>(null);
  // Use the raw value as the select state so the user's NULL choice maps to
  // a distinct option separate from "false".
  const initial =
    value === null || value === undefined ? "null" : value ? "true" : "false";
  const [choice, setChoice] = useState<"true" | "false" | "null">(
    initial as "true" | "false" | "null",
  );

  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  function commit(next: "true" | "false" | "null" = choice) {
    if (next === "null") return onCommit(null);
    onCommit(next === "true");
  }

  return (
    <InlineWrapper>
      <select
        ref={ref}
        className="h-7 flex-1 bg-transparent px-1 text-xs outline-none"
        value={choice}
        onChange={(e) => {
          const v = e.target.value as "true" | "false" | "null";
          setChoice(v);
          commit(v);
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") commit();
        }}
      >
        <option value="true">true</option>
        <option value="false">false</option>
        {meta.isNullable && <option value="null">NULL</option>}
      </select>
    </InlineWrapper>
  );
}

function UuidEditor({ meta, value, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => toEditableString(value, "uuid"));
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    if (text === "") {
      if (value === null) return onCancel();
      if (meta.isNullable) return onCommit(null);
      setError("Required");
      return;
    }
    if (!UUID_RE.test(text)) {
      setError("Not a UUID");
      return;
    }
    onCommit(text);
  }

  function generate() {
    const uuid =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : fallbackUuid();
    setText(uuid);
    setError(null);
    // Focus stays on the field so the user can review or press Enter to
    // commit; this matches the existing UX patterns of "generate and review."
    requestAnimationFrame(() => ref.current?.select());
  }

  return (
    <InlineWrapper className={error ? "ring-destructive" : undefined}>
      <input
        ref={ref}
        className={baseInputCls}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
        placeholder="00000000-0000-0000-0000-000000000000"
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={generate}
        title="Generate UUID v4"
        className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
      >
        <Sparkles className="h-3 w-3" />
      </button>
      {meta.isNullable && <NullAction onClick={() => onCommit(null)} />}
    </InlineWrapper>
  );
}

function fallbackUuid(): string {
  // Sufficient for offline / unsupported environments.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

// ---- Dialog editor (json / array) -----------------------------------------

function JsonArrayDialog({
  meta,
  value,
  onCommit,
  onCancel,
  kind,
}: CellEditorProps & { kind: "json" | "array" }) {
  // The dialog mounts open immediately so opening the cell editor and the
  // popup feels like one motion. Closing the dialog cancels the edit unless
  // the user clicked the explicit Save button.
  const [text, setText] = useState(() =>
    value === null ? "" : toEditableString(value, "json"),
  );
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(() => {
    if (text === "" && meta.isNullable) {
      onCommit(null);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (kind === "array" && !Array.isArray(parsed)) {
      setError("Array column requires a JSON array (e.g. [\"a\", \"b\"]).");
      return;
    }
    onCommit(parsed);
  }, [text, meta.isNullable, onCommit, kind]);

  // Cmd/Ctrl-Enter to save without taking focus off the textarea — matches
  // the QueryRunner editor convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Edit ${kind === "json" ? "JSON" : "array"} value`}
      className="max-w-3xl"
      footer={
        <>
          {meta.isNullable && text !== "" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText("");
                setError(null);
              }}
            >
              Clear
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            <Check className="h-3 w-3" />
            Save
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        spellCheck={false}
        className="min-h-[280px] w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs"
        placeholder={
          kind === "json" ? '{ "key": "value" }' : '["item1", "item2"]'
        }
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {meta.isNullable
          ? "Empty value saves as SQL NULL. Cmd/Ctrl + Enter to save."
          : "Cmd/Ctrl + Enter to save."}
      </p>
      {error && (
        <div className="mt-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </Dialog>
  );
}

// ---- Small affordances ----------------------------------------------------

function NullAction({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      // mousedown.preventDefault keeps the input's blur from firing first,
      // which would commit the current text before the NULL click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="mr-1 rounded-sm px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
      title="Set to NULL"
    >
      ∅
    </button>
  );
}

export function CancelHint() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
      <X className="h-2.5 w-2.5" /> Esc
    </span>
  );
}
