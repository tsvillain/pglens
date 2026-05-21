import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Loading } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import {
  connect,
  updateConnectionApi,
  type ConnectPayload,
} from '@/lib/api'
import { useConnectionStore } from '@/store/connection'

type Mode = 'params' | 'url'
type Ssl = NonNullable<ConnectPayload['sslMode']>

// Sentinel value swapped in for the password in masked URLs returned by
// GET /api/connections. The server treats a literal "***" on PUT as
// "keep the existing keychain entry".
const PW_SENTINEL = '***'

export interface ConnectionEdit {
  id: string
  name?: string
  connectionString?: string
  host?: string
  port?: number
  database?: string
  username?: string
  sslMode?: string
  schema?: string
}

interface ConnectionDialogProps {
  open: boolean
  onClose: () => void
  edit?: ConnectionEdit
}

function isValidSsl(s: string | undefined): s is Ssl {
  return s === 'prefer' || s === 'require' || s === 'disable' ||
    s === 'verify-ca' || s === 'verify-full'
}

function buildUrl(host: string, port: string, db: string, user: string, pw: string) {
  const password = pw || ''
  const auth = `${encodeURIComponent(user)}${password ? ':' + encodeURIComponent(password) : ''}@`
  return `postgresql://${auth}${host}:${port || '5432'}/${db}`
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
      // Default to URL mode when we have a masked connection string; both
      // tabs stay prefilled so the user can switch without losing context.
      setMode(edit.connectionString ? 'url' : 'params')
      setName(edit.name ?? '')
      setUrl(edit.connectionString ?? '')
      setHost(edit.host ?? 'localhost')
      setPort(edit.port ? String(edit.port) : '5432')
      setDb(edit.database ?? 'postgres')
      setUser(edit.username ?? '')
      setPw('')
      setSslMode(isValidSsl(edit.sslMode) ? edit.sslMode : 'prefer')
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
      let finalUrl: string
      if (mode === 'url') {
        finalUrl = url
      } else {
        // In params edit mode, an empty password means "keep current". Send
        // the sentinel so the server pulls the real password from the keychain.
        const effectivePw = pw === '' && edit ? PW_SENTINEL : pw
        finalUrl = buildUrl(host, port, db, user, effectivePw)
      }
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
            {mutation.isPending ? (
              <Loading>{edit ? 'Saving connection…' : 'Connecting…'}</Loading>
            ) : edit ? (
              'Save'
            ) : (
              'Connect'
            )}
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
          <Field
            label="Connection URL"
            hint={
              edit
                ? `Password is masked as "${PW_SENTINEL}". Leave it as-is to keep the existing password.`
                : undefined
            }
          >
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
              <Field
                label="Password"
                hint={edit ? 'Leave blank to keep current.' : undefined}
              >
                <Input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder={edit ? '(unchanged)' : ''}
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
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>
      )}
    </label>
  )
}
