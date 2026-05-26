import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check, ChevronDown, Plus, Save, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  createView, deleteView, listViews, updateView,
  type FilterGroup, type SavedView, type SortEntry,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface ViewBarProps {
  connectionId: string
  tableName: string
  /** `null` means the synthetic "All rows" default. */
  selectedViewId: string | null
  onSelectView: (id: string | null) => void
  filter: FilterGroup
  sort: SortEntry[]
}

/**
 * Two snapshots are "equivalent" when the JSON-stringified payload matches.
 * The filter/sort UI keeps these in a canonical shape (FilterGroup with `and`
 * combinator at the root, sort entries lowercase) so stringify is enough —
 * we don't need a structural deep-equal here.
 */
function isSameSnapshot(
  a: { filter?: unknown; sort?: unknown },
  b: { filter?: unknown; sort?: unknown },
): boolean {
  if (JSON.stringify(a.filter ?? null) !== JSON.stringify(b.filter ?? null)) {
    return false
  }
  return JSON.stringify(a.sort ?? []) === JSON.stringify(b.sort ?? [])
}

export function ViewBar({
  connectionId, tableName, selectedViewId, onSelectView, filter, sort,
}: ViewBarProps) {
  const qc = useQueryClient()
  const viewsKey = ['views', connectionId, tableName] as const

  const viewsQuery = useQuery({
    queryKey: viewsKey,
    queryFn: ({ signal }) =>
      listViews({ connectionId, tableName }, signal).then((r) => r.views),
  })

  const selected: SavedView | null =
    viewsQuery.data?.find((v) => v.id === selectedViewId) ?? null

  // "Dirty" = the working filter/sort no longer matches the saved view (or,
  // for the default, has any state at all). Drives the Save button enabled
  // state + a small dot next to the view name.
  const dirty = selected
    ? !isSameSnapshot({ filter, sort }, selected)
    : filter.children.length > 0 || sort.length > 0

  const createMut = useMutation({
    mutationFn: (name: string) =>
      createView({ connectionId, tableName, name, filter, sort }),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ['views'] })
      onSelectView(v.id)
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => updateView(id, { filter, sort }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      updateView(id, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteView(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['views'] })
      if (selectedViewId === id) onSelectView(null)
    },
  })

  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)

  const lastError =
    (createMut.error as Error | null)?.message
    ?? (updateMut.error as Error | null)?.message
    ?? (renameMut.error as Error | null)?.message
    ?? (deleteMut.error as Error | null)?.message
    ?? null

  return (
    <div className="flex items-center gap-2 border-b border-border bg-background/60 px-4 py-1.5">
      <Bookmark className="h-3.5 w-3.5 text-muted-foreground" />

      <Dropdown
        align="start"
        trigger={({ open }) => (
          <span
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent',
              open && 'bg-accent',
            )}
          >
            <span className="max-w-[200px] truncate">
              {selected?.name ?? 'All rows'}
            </span>
            {dirty && (
              <span
                title="Unsaved changes"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              />
            )}
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </span>
        )}
        className="w-64"
      >
        <DropdownItem onClick={() => onSelectView(null)}>
          <span className="flex w-full items-center justify-between">
            <span>All rows</span>
            {selectedViewId === null && <Check className="h-3.5 w-3.5" />}
          </span>
        </DropdownItem>
        {viewsQuery.data && viewsQuery.data.length > 0 && (
          <div className="my-1 border-t border-border" />
        )}
        {viewsQuery.data?.map((v) => (
          <DropdownItem key={v.id} onClick={() => onSelectView(v.id)}>
            <span className="flex w-full items-center justify-between gap-2">
              <span className="truncate">{v.name}</span>
              {selectedViewId === v.id && (
                <Check className="h-3.5 w-3.5 shrink-0" />
              )}
            </span>
          </DropdownItem>
        ))}
        {viewsQuery.isLoading && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            <Spinner aria-label="Loading views" /> Loading…
          </div>
        )}
      </Dropdown>

      <div className="ml-1 flex items-center gap-1">
        {selected && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty || updateMut.isPending}
            onClick={() => updateMut.mutate(selected.id)}
            title={dirty ? `Save changes to "${selected.name}"` : 'No unsaved changes'}
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            Save
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSaveAsOpen(true)}
          title="Save current filter, sort as a new view"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Save as…
        </Button>
        {selected && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRenameOpen(true)}
              title={`Rename "${selected.name}"`}
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(`Delete view "${selected.name}"?`)) {
                  deleteMut.mutate(selected.id)
                }
              }}
              title={`Delete "${selected.name}"`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      {lastError && (
        <span className="ml-auto truncate text-xs text-destructive" title={lastError}>
          {lastError}
        </span>
      )}

      <NameDialog
        open={saveAsOpen}
        title="Save view"
        label="View name"
        confirmLabel="Save"
        pending={createMut.isPending}
        onSubmit={(name) => {
          createMut.mutate(name, {
            onSuccess: () => setSaveAsOpen(false),
          })
        }}
        onClose={() => setSaveAsOpen(false)}
      />
      <NameDialog
        open={renameOpen}
        title="Rename view"
        label="New name"
        confirmLabel="Rename"
        initialValue={selected?.name ?? ''}
        pending={renameMut.isPending}
        onSubmit={(name) => {
          if (!selected) return
          renameMut.mutate(
            { id: selected.id, name },
            { onSuccess: () => setRenameOpen(false) },
          )
        }}
        onClose={() => setRenameOpen(false)}
      />
    </div>
  )
}

interface NameDialogProps {
  open: boolean
  title: string
  label: string
  confirmLabel: string
  initialValue?: string
  pending?: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}

function NameDialog({
  open, title, label, confirmLabel, initialValue = '', pending, onSubmit, onClose,
}: NameDialogProps) {
  const [name, setName] = useState(initialValue)
  // Reset the input when the dialog reopens so a previous attempt doesn't
  // leak into a fresh save.
  useEffect(() => {
    if (open) setName(initialValue)
  }, [open, initialValue])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !pending

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!canSubmit}
            onClick={() => canSubmit && onSubmit(trimmed)}
          >
            {pending ? <Spinner aria-label="Saving" /> : confirmLabel}
          </Button>
        </>
      }
    >
      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) onSubmit(trimmed)
          }}
          placeholder="e.g. Open orders"
          className="mt-1"
        />
      </label>
    </Dialog>
  )
}
