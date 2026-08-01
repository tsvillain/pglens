import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Cloud as CloudIcon, CreditCard, Database, LogOut, Plus, ShieldCheck, UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Loading, Spinner } from '@/components/ui/spinner'
import { CopyButton } from '@/components/CopyButton'
import {
  getCloudStatus, signIn, signOut, listCloudWorkspaces, createCloudWorkspace,
  selectCloudWorkspace, deselectCloudWorkspace, listCloudMembers, setCloudMemberLevel, createCloudInvite,
  startCheckout, openBillingPortal, setWorkspaceSeats, listCloudConnections,
  type AccessLevel, type CloudMember, type PlanKey,
} from '@/lib/cloudApi'
import { listConnections, provisionRole } from '@/lib/api'
import { useQuerySeedStore } from '@/store/querySeed'
import { useTabsStore } from '@/store/tabs'

const LEVELS: AccessLevel[] = ['read', 'write', 'admin', 'owner']

// Dodo redirects the browser back to returnUrl (?checkout=return) once a
// hosted checkout/portal session finishes — win or lose, cancel or confirm.
// The actual plan change only lands once the webhook does (async, usually
// within a couple seconds), so a short poll window beats a single refetch
// racing the webhook. Same "dumb and reliable" call as the sign-in poll below.
function useCheckoutReturn() {
  const [pending, setPending] = useState(() => new URLSearchParams(window.location.search).get('checkout') === 'return')
  useEffect(() => {
    if (!pending) return
    window.history.replaceState({}, '', '/cloud')
    const timeout = setTimeout(() => setPending(false), 20000)
    return () => clearTimeout(timeout)
  }, [pending])
  return pending
}

export function Cloud() {
  const qc = useQueryClient()
  const checkoutPending = useCheckoutReturn()

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
          ? <WorkspaceDetail workspaceId={status.data.workspaceId} myEmail={status.data.email!} checkoutPending={checkoutPending} />
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
    <div className="max-w-md space-y-4">
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
            <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 truncate">{w.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  w.plan === 'pro' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {w.plan === 'pro' ? `Pro · ${w.seat_count} ${w.seat_count === 1 ? 'seat' : 'seats'}` : 'Free'}
                </span>
                <Button size="sm" variant="outline" onClick={() => select.mutate(w.id)} disabled={select.isPending}>
                  Open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function WorkspaceDetail({ workspaceId, myEmail, checkoutPending }: { workspaceId: string; myEmail: string; checkoutPending: boolean }) {
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

  const deselect = useMutation({
    mutationFn: deselectCloudWorkspace,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-status'] }),
  })

  return (
    <div className="space-y-4">
      <Button size="sm" variant="ghost" className="-ml-2 h-7" onClick={() => deselect.mutate()} disabled={deselect.isPending}>
        {deselect.isPending ? <Spinner aria-label="Leaving workspace" /> : <ArrowLeft className="h-3.5 w-3.5" />}
        All workspaces
      </Button>
      <WorkspaceBillingPanel workspaceId={workspaceId} canManage={canManage} checkoutPending={checkoutPending} />
      <SharedConnections workspaceId={workspaceId} />
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

// Sharing a connection into a workspace is implicit, not a button anywhere:
// whichever workspace is selected when you create/edit a connection gets it
// pushed automatically (src/cloud/sync.js's syncAdapter). This list is the
// missing other half — actually seeing the result of that, which previously
// had no UI at all even though pglens-cloud has had the endpoint since M3.
function SharedConnections({ workspaceId }: { workspaceId: string }) {
  const connections = useQuery({
    queryKey: ['cloud-connections', workspaceId],
    queryFn: ({ signal }) => listCloudConnections(workspaceId, signal),
  })

  return (
    <div>
      <h2 className="text-sm font-medium text-muted-foreground">Connections</h2>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        Shared automatically — whichever connection is active when you create or edit it, while this
        workspace is open, gets pushed here for every member.
      </p>
      {connections.isLoading && <Loading>Loading connections…</Loading>}
      {connections.data && connections.data.connections.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          None yet. Open a connection while this workspace is selected to share it.
        </p>
      )}
      {!!connections.data?.connections.length && (
        <ul className="mt-2 divide-y divide-border/50 overflow-hidden rounded-lg border border-border bg-card">
          {connections.data.connections.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {c.username}@{c.host}:{c.port}/{c.database}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// The workspace is the only thing that has a plan — one line, no separate
// "your plan" concept anywhere. Solo users are just a one-seat workspace.
function WorkspaceBillingPanel({ workspaceId, canManage, checkoutPending }: { workspaceId: string; canManage: boolean; checkoutPending: boolean }) {
  const workspaces = useQuery({
    queryKey: ['cloud-workspaces'],
    queryFn: ({ signal }) => listCloudWorkspaces(signal),
    refetchInterval: checkoutPending ? 1500 : false,
  })
  const workspace = workspaces.data?.workspaces.find((w) => w.id === workspaceId)
  const [newSeatCount, setNewSeatCount] = useState(1)

  const checkout = useMutation({
    mutationFn: (key: PlanKey) => startCheckout({ key, workspaceId, seatCount: newSeatCount }),
  })
  const portal = useMutation({ mutationFn: () => openBillingPortal(workspaceId) })

  if (!workspace) return null

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-2.5">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">Plan</span>
        <span className="font-medium">{workspace.plan === 'pro' ? 'Pro' : 'Free'}</span>
        {workspace.plan === 'pro' && (
          <span className="text-muted-foreground">
            · {workspace.seat_count} {workspace.seat_count === 1 ? 'seat' : 'seats'}
          </span>
        )}
        {workspace.plan !== 'free' && workspace.billing_status !== 'active' && (
          <span className="text-destructive">({workspace.billing_status})</span>
        )}
        {canManage && (
          <div className="ml-auto flex items-center gap-2">
            {workspace.plan === 'free' ? (
              <>
                <Input
                  type="number"
                  min={1}
                  value={newSeatCount}
                  onChange={(e) => setNewSeatCount(Math.max(1, Number(e.target.value) || 1))}
                  className="h-7 w-14 text-xs"
                  aria-label="Seats to purchase"
                />
                <span className="text-muted-foreground">{newSeatCount === 1 ? 'seat' : 'seats'}</span>
                <Button size="sm" variant="outline" className="h-7" onClick={() => checkout.mutate('pro_monthly')} disabled={checkout.isPending}>
                  {checkout.isPending && <Spinner aria-label="Starting checkout" />}
                  Upgrade to Pro — ${newSeatCount * 9}/mo
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => checkout.mutate('pro_yearly')} disabled={checkout.isPending}>
                  ${newSeatCount * 90}/yr
                </Button>
              </>
            ) : (
              <>
                <SeatEditor workspaceId={workspaceId} seatCount={workspace.seat_count} />
                <Button size="sm" variant="outline" className="h-7" onClick={() => portal.mutate()} disabled={portal.isPending}>
                  {portal.isPending ? <Spinner aria-label="Opening billing portal" /> : <CreditCard className="h-3.5 w-3.5" />}
                  Manage billing
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        {workspace.plan === 'pro'
          ? 'Unlimited connections, cross-device sync, shared access with real Postgres roles, 90-day audit log.'
          : 'Free: 1 member, 1 synced connection. Pro adds unlimited connections, sync, teammates (one seat each), access levels, and the audit log.'}
      </p>
      {!canManage && (
        <p className="mt-1 text-[11px] text-muted-foreground">Only an owner or admin can change the plan.</p>
      )}
      {checkout.error && <p className="mt-1 text-xs text-destructive">{(checkout.error as Error).message}</p>}
      {portal.error && <p className="mt-1 text-xs text-destructive">{(portal.error as Error).message}</p>}
    </div>
  )
}

function SeatEditor({ workspaceId, seatCount }: { workspaceId: string; seatCount: number }) {
  const qc = useQueryClient()
  const [value, setValue] = useState(seatCount)

  const update = useMutation({
    mutationFn: () => setWorkspaceSeats(workspaceId, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-workspaces'] }),
  })

  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(e) => setValue(Math.max(1, Number(e.target.value) || 1))}
        className="h-7 w-14 text-xs"
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        onClick={() => update.mutate()}
        disabled={update.isPending || value === seatCount}
      >
        {update.isPending ? <Spinner aria-label="Updating seats" /> : 'Update seats'}
      </Button>
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
