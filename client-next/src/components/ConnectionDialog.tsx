import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  connect,
  updateConnectionApi,
  type ConnectPayload,
} from '@/lib/api'
import { useConnectionStore } from '@/store/connection'

type Mode = 'params' | 'url'
type Ssl = NonNullable<ConnectPayload['sslMode']>

interface ConnectionDialogProps {
  open: boolean
  onClose: () => void
  edit?: { id: string; name?: string; url?: string; sslMode?: Ssl; schema?: string }
}

function buildUrl(host: string, port: string, db: string, user: string, pw: string) {
  const u = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@${host}:${port || '5432'}/${db}`
  return u
}

export function ConnectionDialog({ open, onClose, edit }: ConnectionDialogProps) {
  const qc = useQueryClient()
  const setActive = useConnectionStore((s) => s.setActive)

  const [mode, setMode] = useState<Mode>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('5432')
  const [db, setDb] = useState('postgres')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [sslMode, setSslMode] = useState<Ssl>('prefer')
  const [schema, setSchema] = useState('public')

  useEffect(() => {
    if (!open) return
    if (edit) {
      setMode('url')
      setName(edit.name ?? '')
      setUrl(edit.url ?? '')
      setSslMode(edit.sslMode ?? 'prefer')
      setSchema(edit.schema ?? 'public')
    } else {
      setMode('url')
      setName('')
      setUrl('')
      setHost('localhost')
      setPort('5432')
      setDb('postgres')
      setUser('')
      setPw('')
      setSslMode('prefer')
      setSchema('public')
    }
  }, [open, edit])

  const mutation = useMutation({
    mutationFn: async () => {
      const finalUrl =
        mode === 'url' ? url : buildUrl(host, port, db, user, pw)
      const payload: ConnectPayload = {
        url: finalUrl,
        sslMode,
        name: name || undefined,
        schema: schema || 'public',
      }
      const res = edit
        ? await updateConnectionApi(edit.id, payload)
        : await connect(payload)
      const id = res.connectionId ?? edit?.id
      if (!id) throw new Error('Server did not return a connection id')
      return { id, name: res.name }
    },
    onSuccess: ({ id }) => {
      setActive(id)
      qc.invalidateQueries({ queryKey: ['connections'] })
      onClose()
    },
  })

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!mutation.isPending) onClose()
      }}
      title={edit ? 'Edit connection' : 'New connection'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Connecting…' : edit ? 'Save' : 'Connect'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="inline-flex rounded-md border border-border bg-muted p-0.5 text-sm">
          {(['url', 'params'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-3 py-1 capitalize',
                mode === m && 'bg-card shadow-sm',
              )}
              type="button"
            >
              {m === 'url' ? 'Connection URL' : 'Parameters'}
            </button>
          ))}
        </div>

        <Field label="Connection name (optional)">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production DB"
          />
        </Field>

        {mode === 'url' ? (
          <Field label="Connection URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="postgresql://user:password@host:5432/dbname"
              autoFocus
            />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field label="Host">
                  <Input value={host} onChange={(e) => setHost(e.target.value)} />
                </Field>
              </div>
              <Field label="Port">
                <Input value={port} onChange={(e) => setPort(e.target.value)} />
              </Field>
            </div>
            <Field label="Database">
              <Input value={db} onChange={(e) => setDb(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <Input value={user} onChange={(e) => setUser(e.target.value)} />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
              </Field>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="SSL mode">
            <Select
              value={sslMode}
              onChange={(e) => setSslMode(e.target.value as Ssl)}
            >
              <option value="prefer">Prefer</option>
              <option value="require">Require</option>
              <option value="disable">Disable</option>
              <option value="verify-ca">Verify CA</option>
              <option value="verify-full">Verify Full</option>
            </Select>
          </Field>
          <Field label="Schema">
            <Input value={schema} onChange={(e) => setSchema(e.target.value)} />
          </Field>
        </div>

        {mutation.error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
            {(mutation.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
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
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}
