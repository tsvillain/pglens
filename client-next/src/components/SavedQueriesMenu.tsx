import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Download, FolderClosed, Pencil, Save, Star, Trash2, Upload,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Dropdown } from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  createSavedQuery,
  deleteSavedQuery,
  importSavedQueries,
  listSavedQueries,
  updateSavedQuery,
  type SavedQuery,
  type SaveQueryImport,
} from '@/lib/api'
import { applyTemplate, extractTemplateVars, hasTemplateVars } from '@/lib/sqlTemplate'
import { cn } from '@/lib/utils'

const UNGROUPED = '__ungrouped__'

interface SavedQueriesMenuProps {
  connectionId: string
  /** The editor's current SQL — seeds the "Save current query" dialog. */
  currentSql: string
  /** Load a saved query's (resolved) SQL into the editor. */
  onLoad: (sql: string) => void
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const t of raw.split(',').map((s) => s.trim()).filter(Boolean)) seen.add(t)
  return [...seen]
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Saved queries (roadmap §5.5): a per-connection library of raw SQL with
 * folder/tag organization and Postman-style `{{variable}}` defaults. The
 * dropdown lists saved queries grouped by folder; loading one substitutes its
 * `{{variables}}` (via a fill dialog) before dropping the SQL into the editor.
 */
export function SavedQueriesMenu({ connectionId, currentSql, onLoad }: SavedQueriesMenuProps) {
  const qc = useQueryClient()
  const savedKey = ['saved-queries', connectionId] as const

  const savedQuery = useQuery({
    queryKey: savedKey,
    queryFn: ({ signal }) =>
      listSavedQueries(connectionId, signal).then((r) => r.savedQueries),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSavedQuery(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedKey }),
  })

  const importMut = useMutation({
    mutationFn: (items: SaveQueryImport[]) => importSavedQueries(connectionId, items),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedKey }),
  })

  const [search, setSearch] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [editing, setEditing] = useState<SavedQuery | null>(null)
  const [fillFor, setFillFor] = useState<SavedQuery | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const all = savedQuery.data ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.folder ?? '').toLowerCase().includes(q) ||
        (s.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    )
  }, [all, search])

  // Group by folder; ungrouped queries sort last under their own header.
  const groups = useMemo(() => {
    const byFolder = new Map<string, SavedQuery[]>()
    for (const s of filtered) {
      const key = s.folder?.trim() ? s.folder : UNGROUPED
      ;(byFolder.get(key) ?? byFolder.set(key, []).get(key)!).push(s)
    }
    return [...byFolder.entries()].sort(([a], [b]) => {
      if (a === UNGROUPED) return 1
      if (b === UNGROUPED) return -1
      return a.localeCompare(b)
    })
  }, [filtered])

  function loadSaved(s: SavedQuery) {
    if (hasTemplateVars(s.sql)) {
      setFillFor(s)
    } else {
      onLoad(s.sql)
    }
  }

  function onPickImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-importing the same file
    if (!file) return
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text)
        const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed?.savedQueries
        if (!Array.isArray(arr)) throw new Error('Expected a JSON array of saved queries')
        const items: SaveQueryImport[] = arr.map((raw) => {
          const r = raw as Record<string, unknown>
          if (typeof r.name !== 'string' || typeof r.sql !== 'string') {
            throw new Error('Each item needs a "name" and "sql" string')
          }
          return {
            name: r.name,
            sql: r.sql,
            description: typeof r.description === 'string' ? r.description : undefined,
            folder: typeof r.folder === 'string' ? r.folder : undefined,
            tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
            variables:
              r.variables && typeof r.variables === 'object'
                ? (r.variables as Record<string, string>)
                : undefined,
          }
        })
        importMut.mutate(items)
      })
      .catch((err: unknown) => {
        window.alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  const lastError =
    (deleteMut.error as Error | null)?.message ??
    (importMut.error as Error | null)?.message ??
    null

  return (
    <>
      <Dropdown
        align="end"
        className="w-[24rem]"
        trigger={({ open }) => (
          <span
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent',
              open && 'bg-accent',
            )}
            title="Saved queries (this connection)"
          >
            <Star className="h-3.5 w-3.5" />
            Saved
            {all.length > 0 && (
              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {all.length}
              </span>
            )}
          </span>
        )}
      >
        <div className="px-1 py-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name, folder, tag…"
            className="h-7 text-xs"
          />
        </div>
        <div className="my-1 border-t border-border" />

        <div className="max-h-[20rem] overflow-y-auto">
          {savedQuery.isLoading && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              <Spinner aria-label="Loading saved queries" /> Loading…
            </div>
          )}
          {!savedQuery.isLoading && all.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No saved queries. Save the current one below.
            </div>
          )}
          {!savedQuery.isLoading && all.length > 0 && filtered.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">No matches.</div>
          )}
          {groups.map(([folder, items]) => (
            <div key={folder} className="mb-1">
              <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <FolderClosed className="h-3 w-3" />
                {folder === UNGROUPED ? 'No folder' : folder}
              </div>
              <ul className="space-y-0.5">
                {items.map((s) => (
                  <SavedRow
                    key={s.id}
                    saved={s}
                    onLoad={() => loadSaved(s)}
                    onEdit={() => setEditing(s)}
                    onDelete={() => {
                      if (window.confirm(`Delete saved query "${s.name}"?`)) {
                        deleteMut.mutate(s.id)
                      }
                    }}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="my-1 border-t border-border" />
        <div className="flex items-center gap-1 px-1 pb-0.5">
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            className="flex flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            <Save className="h-3.5 w-3.5" /> Save current query…
          </button>
          <button
            type="button"
            aria-label="Import saved queries from JSON"
            title="Import from JSON"
            onClick={(e) => {
              e.stopPropagation()
              fileInputRef.current?.click()
            }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {importMut.isPending ? <Spinner aria-label="Importing" /> : <Upload className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Export saved queries to JSON"
            title="Export to JSON"
            disabled={all.length === 0}
            onClick={(e) => {
              e.stopPropagation()
              const payload = all.map(({ name, sql, description, folder, tags, variables }) => ({
                name, sql, description, folder, tags, variables,
              }))
              downloadJson('pglens-saved-queries.json', payload)
            }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
        {lastError && (
          <p className="px-2 pb-1 text-[11px] text-destructive">{lastError}</p>
        )}
      </Dropdown>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onPickImportFile}
      />

      <SaveQueryDialog
        open={saveOpen || editing !== null}
        connectionId={connectionId}
        editing={editing}
        initialSql={editing?.sql ?? currentSql}
        onClose={() => {
          setSaveOpen(false)
          setEditing(null)
        }}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: savedKey })
          setSaveOpen(false)
          setEditing(null)
        }}
      />

      <TemplateVarsDialog
        saved={fillFor}
        onClose={() => setFillFor(null)}
        onConfirm={(sql) => {
          onLoad(sql)
          setFillFor(null)
        }}
      />
    </>
  )
}

function SavedRow({
  saved,
  onLoad,
  onEdit,
  onDelete,
}: {
  saved: SavedQuery
  onLoad: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <li className="group flex items-center gap-1 rounded hover:bg-accent">
      <button
        type="button"
        onClick={onLoad}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        title="Load into the editor"
      >
        <span className="truncate">{saved.name}</span>
        {(saved.tags ?? []).slice(0, 3).map((t) => (
          <span
            key={t}
            className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
          >
            {t}
          </span>
        ))}
      </button>
      <button
        type="button"
        aria-label="Edit saved query"
        onClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
        className="shrink-0 p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Delete saved query"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="shrink-0 p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}

interface SaveQueryDialogProps {
  open: boolean
  connectionId: string
  /** When set, the dialog edits this query (PUT); otherwise it creates one. */
  editing: SavedQuery | null
  initialSql: string
  onClose: () => void
  onSaved: () => void
}

function SaveQueryDialog({
  open, connectionId, editing, initialSql, onClose, onSaved,
}: SaveQueryDialogProps) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [tags, setTags] = useState('')
  const [description, setDescription] = useState('')
  const [sql, setSql] = useState(initialSql)
  const [varDefaults, setVarDefaults] = useState<Record<string, string>>({})

  // Re-seed every time the dialog opens (create vs edit, or new editor content).
  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setFolder(editing?.folder ?? '')
    setTags((editing?.tags ?? []).join(', '))
    setDescription(editing?.description ?? '')
    setSql(editing?.sql ?? initialSql)
    setVarDefaults(editing?.variables ?? {})
  }, [open, editing, initialSql])

  const vars = useMemo(() => extractTemplateVars(sql), [sql])

  const saveMut = useMutation({
    mutationFn: () => {
      const variables = vars.length
        ? Object.fromEntries(vars.map((v) => [v, varDefaults[v] ?? '']))
        : null
      const payload = {
        connectionId,
        name: name.trim(),
        sql,
        description: description.trim() || null,
        folder: folder.trim() || null,
        tags: parseTags(tags),
        variables,
      }
      return editing ? updateSavedQuery(editing.id, payload) : createSavedQuery(payload)
    },
    onSuccess: onSaved,
  })

  const canSubmit = name.trim().length > 0 && sql.trim().length > 0 && !saveMut.isPending

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit saved query' : 'Save query'}
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!canSubmit} onClick={() => canSubmit && saveMut.mutate()}>
            {saveMut.isPending ? <Spinner aria-label="Saving" /> : editing ? 'Save changes' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Open orders"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Folder (optional)">
            <Input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="e.g. Reports/Daily"
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="orders, daily"
            />
          </Field>
        </div>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </Field>
        <Field label="SQL">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </Field>
        {vars.length > 0 && (
          <Field label={`Template variables (${vars.length}) — default values`}>
            <div className="space-y-1.5">
              {vars.map((v) => (
                <label key={v} className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 truncate font-mono text-muted-foreground">{`{{${v}}}`}</span>
                  <Input
                    value={varDefaults[v] ?? ''}
                    onChange={(e) =>
                      setVarDefaults((prev) => ({ ...prev, [v]: e.target.value }))
                    }
                    placeholder="default value"
                    className="h-7 text-xs"
                  />
                </label>
              ))}
            </div>
          </Field>
        )}
        {saveMut.error && (
          <p className="text-xs text-destructive">{(saveMut.error as Error).message}</p>
        )}
      </div>
    </Dialog>
  )
}

interface TemplateVarsDialogProps {
  saved: SavedQuery | null
  onClose: () => void
  onConfirm: (resolvedSql: string) => void
}

/**
 * Shown when loading a saved query that contains `{{variables}}`. Pre-fills each
 * with the saved default, then substitutes them into the SQL before it lands in
 * the editor (where the user can still review/edit before running).
 */
function TemplateVarsDialog({ saved, onClose, onConfirm }: TemplateVarsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const vars = useMemo(() => (saved ? extractTemplateVars(saved.sql) : []), [saved])

  useEffect(() => {
    if (saved) setValues(saved.variables ?? {})
  }, [saved])

  return (
    <Dialog
      open={saved !== null}
      onClose={onClose}
      title={saved ? `Variables for "${saved.name}"` : 'Variables'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => saved && onConfirm(applyTemplate(saved.sql, values))}
          >
            Load
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          These values are substituted into the SQL before it opens in the editor.
        </p>
        {vars.map((v) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <span className="w-28 shrink-0 truncate font-mono text-xs text-muted-foreground">{`{{${v}}}`}</span>
            <Input
              value={values[v] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [v]: e.target.value }))}
              placeholder="value"
            />
          </label>
        ))}
      </div>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
