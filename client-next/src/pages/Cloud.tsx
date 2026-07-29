import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Cloud as CloudIcon, LogOut, Plus, ShieldCheck, UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Loading, Spinner } from '@/components/ui/spinner'
import { CopyButton } from '@/components/CopyButton'
import {
  getCloudStatus, signIn, signOut, listCloudWorkspaces, createCloudWorkspace,
  selectCloudWorkspace, listCloudMembers, setCloudMemberLevel, createCloudInvite,
  type AccessLevel, type CloudMember,
} from '@/lib/cloudApi'
import { listConnections, provisionRole } from '@/lib/api'
import { useQuerySeedStore } from '@/store/querySeed'
import { useTabsStore } from '@/store/tabs'

const LEVELS: AccessLevel[] = ['read', 'write', 'admin', 'owner']

export function Cloud() {
  const qc = useQueryClient()

  const status = useQuery({
    queryKey: ['cloud-status'],
    queryFn: ({ signal }) => getCloudStatus(signal),
    // While a sign-in popup might be open, poll for it to complete —
    // "dumb and reliable" beats cross-window messaging for something this rare.
    refetchInterval: (query) => (query.state.data?.signedIn ? false : 2000),
  })

  const doSignIn = useMutation({ mutationFn: signIn })
  const doSignOut = useMutation({
    mutationFn: signOut,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-status'] }),
  })

  if (status.isLoading) {
    return <div className="px-10 py-10 text-sm text-muted-foreground"><Loading>Loading…</Loading></div>
  }

  if (!status.data?.signedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-10 text-center">
        <CloudIcon className="h-8 w-8 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-semibold">Sign in to pglens cloud</h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Sync connections across devices and share them with a team. Everything stays optional —
            pglens works fully offline without this.
          </p>
        </div>
        <Button onClick={() => doSignIn.mutate()} disabled={doSignIn.isPending}>
          {doSignIn.isPending && <Spinner aria-label="Opening sign-in" />}
          Sign in
        </Button>
        <p className="text-xs text-muted-foreground">Opens a window — this page updates once you're signed in.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Cloud</h1>
          <p className="text-xs text-muted-foreground">Signed in as {status.data.email}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => doSignOut.mutate()} disabled={doSignOut.isPending}>
          {doSignOut.isPending ? <Spinner aria-label="Signing out" /> : <LogOut className="h-3.5 w-3.5" />}
          Sign out
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {status.data.workspaceId
          ? <WorkspaceDetail workspaceId={status.data.workspaceId} myEmail={status.data.email!} />
          : <WorkspacePicker />}
      </div>
    </div>
  )
}

function WorkspacePicker() {
  const qc = useQueryClient()
  const [name, setName] = useState('')

  const workspaces = useQuery({
    queryKey: ['cloud-workspaces'],
    queryFn: ({ signal }) => listCloudWorkspaces(signal),
  })

  const create = useMutation({
    mutationFn: (n: string) => createCloudWorkspace(n),
    onSuccess: ({ workspace }) => {
      setName('')
      qc.invalidateQueries({ queryKey: ['cloud-workspaces'] })
      select.mutate(workspace.id)
    },
  })

  const select = useMutation({
    mutationFn: (id: string) => selectCloudWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-status'] }),
  })

  return (
    <div className="max-w-sm space-y-4">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New workspace name"
          className="h-8 text-sm"
        />
        <Button size="sm" onClick={() => name.trim() && create.mutate(name.trim())} disabled={create.isPending}>
          {create.isPending ? <Spinner aria-label="Creating" /> : <Plus className="h-3.5 w-3.5" />}
          Create
        </Button>
      </div>

      {workspaces.isLoading && <Loading>Loading workspaces…</Loading>}
      {!!workspaces.data?.workspaces.length && (
        <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border bg-card">
          {workspaces.data.workspaces.map((w) => (
            <li key={w.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              {w.name}
              <Button size="sm" variant="outline" onClick={() => select.mutate(w.id)} disabled={select.isPending}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function WorkspaceDetail({ workspaceId, myEmail }: { workspaceId: string; myEmail: string }) {
  const qc = useQueryClient()
  const [provisioningFor, setProvisioningFor] = useState<CloudMember | null>(null)

  const members = useQuery({
    queryKey: ['cloud-members', workspaceId],
    queryFn: ({ signal }) => listCloudMembers(workspaceId, signal),
  })

  const myLevel = useMemo(
    () => members.data?.members.find((m) => m.email === myEmail)?.access_level,
    [members.data, myEmail],
  )
  const canManage = myLevel === 'owner' || myLevel === 'admin'

  const setLevel = useMutation({
    mutationFn: ({ userId, level }: { userId: string; level: AccessLevel }) =>
      setCloudMemberLevel(workspaceId, userId, level),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-members', workspaceId] }),
  })

  const invite = useMutation({ mutationFn: () => createCloudInvite(workspaceId) })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Members</h2>
        <Button size="sm" variant="outline" onClick={() => invite.mutate()} disabled={invite.isPending}>
          {invite.isPending ? <Spinner aria-label="Creating invite" /> : <UserPlus className="h-3.5 w-3.5" />}
          Invite
        </Button>
      </div>

      {invite.data && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <code className="min-w-0 flex-1 truncate">{invite.data.inviteUrl}</code>
          <CopyButton text={invite.data.inviteUrl} />
        </div>
      )}

      {members.isLoading && <Loading>Loading members…</Loading>}

      {members.data && (
        <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border bg-card">
          {members.data.members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 truncate">{m.email}</span>
              <div className="flex shrink-0 items-center gap-2">
                <Select
                  value={m.access_level}
                  disabled={!canManage || m.access_level === 'owner'}
                  onChange={(e) => setLevel.mutate({ userId: m.id, level: e.target.value as AccessLevel })}
                  className="h-7 w-28"
                >
                  {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </Select>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setProvisioningFor(m)}>
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Provision
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {provisioningFor && (
        <ProvisionDialog member={provisioningFor} onClose={() => setProvisioningFor(null)} />
      )}
    </div>
  )
}

// Postgres role names: letters/digits/underscore, must start with a letter —
// keeps generated identifiers valid without needing the user to think about it.
function suggestRoleName(email: string) {
  return email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[^a-zA-Z]/, 'u_$&')
}

function ProvisionDialog({ member, onClose }: { member: CloudMember; onClose: () => void }) {
  const navigate = useNavigate()
  const openTab = useTabsStore((s) => s.open)
  const [connectionId, setConnectionId] = useState('')
  const [roleName, setRoleName] = useState(suggestRoleName(member.email))
  const level = member.access_level === 'owner' ? 'admin' : member.access_level

  const connections = useQuery({ queryKey: ['connections'], queryFn: () => listConnections() })

  const provision = useMutation({
    mutationFn: () => provisionRole(connectionId, roleName, level as 'read' | 'write' | 'admin'),
    onSuccess: ({ statements, password }) => {
      const sql = [
        `-- Password for "${roleName}" (shown once — copy it now): ${password}`,
        ...statements,
      ].join('\n')
      useQuerySeedStore.getState().setSeed(sql)
      openTab({ kind: 'query' })
      navigate({ to: '/query' })
      onClose()
    },
  })

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Provision a Postgres role for ${member.email}`}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => provision.mutate()}
            disabled={!connectionId || !roleName || provision.isPending}
          >
            {provision.isPending && <Spinner aria-label="Generating" />}
            Generate DDL
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Generates CREATE ROLE / GRANT statements at the <strong>{level}</strong> level, matching{' '}
          {member.email}&rsquo;s cloud access level. Nothing runs here — the SQL opens in the Query editor
          for you to review and run yourself, same as every other generator in pglens.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Connection to provision on</span>
          <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">Select a connection…</option>
            {connections.data?.connections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Role name</span>
          <Input value={roleName} onChange={(e) => setRoleName(e.target.value)} className="h-8 text-sm" />
        </label>
        {provision.error && (
          <p className="text-xs text-destructive">{(provision.error as Error).message}</p>
        )}
      </div>
    </Dialog>
  )
}
