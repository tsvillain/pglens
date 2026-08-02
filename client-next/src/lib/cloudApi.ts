/**
 * pglens-cloud, proxied through the local server (src/routes/cloud.js).
 * The browser never talks to pglens-cloud directly — the local server holds
 * the session tokens.
 */

import { z } from 'zod'
import { api, postJson } from '@/lib/api'

const StatusResponse = z.object({
  signedIn: z.boolean(),
  email: z.string().nullable(),
  workspaceId: z.string().nullable(),
})
export type CloudStatus = z.infer<typeof StatusResponse>

export function getCloudStatus(signal?: AbortSignal) {
  return api('/api/cloud/status', StatusResponse, { signal })
}

const SigninResponse = z.object({ authUrl: z.string() })

export async function signIn() {
  const { authUrl } = await postJson('/api/cloud/signin', {}, SigninResponse)
  window.open(authUrl, '_blank', 'noopener,noreferrer,width=420,height=640')
}

export function signOut() {
  return postJson('/api/cloud/signout', {}, z.object({ ok: z.boolean() }))
}

const BillingStatus = z.enum(['active', 'on_hold', 'cancelled'])

// The workspace is the only billing subject — users have no plan of their
// own. A solo user is a one-member workspace on the paid plan.
const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  plan: z.enum(['free', 'pro']),
  billing_status: BillingStatus,
  seat_count: z.number(),
})
export type CloudWorkspace = z.infer<typeof WorkspaceSchema>

const WorkspacesResponse = z.object({ workspaces: z.array(WorkspaceSchema) })

export function listCloudWorkspaces(signal?: AbortSignal) {
  return api('/api/cloud/workspaces', WorkspacesResponse, { signal })
}

export function createCloudWorkspace(name: string) {
  return postJson('/api/cloud/workspaces', { name }, z.object({ workspace: WorkspaceSchema }))
}

export function selectCloudWorkspace(workspaceId: string) {
  return postJson(`/api/cloud/workspaces/${workspaceId}/select`, {}, z.object({ ok: z.boolean() }))
}

export function deselectCloudWorkspace() {
  return postJson('/api/cloud/workspaces/deselect', {}, z.object({ ok: z.boolean() }))
}

export const AccessLevel = z.enum(['read', 'write', 'admin', 'owner'])
export type AccessLevel = z.infer<typeof AccessLevel>

const MemberSchema = z.object({
  id: z.string(),
  email: z.string(),
  access_level: AccessLevel,
  joined_at: z.string(),
})
export type CloudMember = z.infer<typeof MemberSchema>

const MembersResponse = z.object({ members: z.array(MemberSchema) })

export function listCloudMembers(workspaceId: string, signal?: AbortSignal) {
  return api(`/api/cloud/workspaces/${workspaceId}/members`, MembersResponse, { signal })
}

const SharedConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  database: z.string(),
  username: z.string(),
})
const SharedConnectionsResponse = z.object({ connections: z.array(SharedConnectionSchema) })

export function listCloudConnections(workspaceId: string, signal?: AbortSignal) {
  return api(`/api/cloud/workspaces/${workspaceId}/connections`, SharedConnectionsResponse, { signal })
}

export function setCloudMemberLevel(workspaceId: string, userId: string, accessLevel: AccessLevel) {
  return postJson(
    `/api/cloud/workspaces/${workspaceId}/members/${userId}`,
    { accessLevel },
    z.object({ member: z.object({ user_id: z.string(), access_level: AccessLevel }) }),
    'PATCH',
  )
}

const InviteResponse = z.object({ inviteUrl: z.string() })

export function createCloudInvite(workspaceId: string) {
  return postJson(`/api/cloud/workspaces/${workspaceId}/invites`, {}, InviteResponse)
}

export const PlanKey = z.enum(['pro_monthly', 'pro_yearly'])
export type PlanKey = z.infer<typeof PlanKey>

const CheckoutResponse = z.object({ checkoutUrl: z.string() })

/**
 * Opens Dodo's hosted checkout in the current window — this navigates away
 * from the app. The local server builds returnUrl itself (routes/cloud.js),
 * embedding the per-install token: Dodo's redirect back is a cross-site
 * top-level navigation, so the SameSite=Strict pglens_token cookie won't
 * ride along on its own, same as the OAuth callback had to account for.
 */
export async function startCheckout(params: { key: PlanKey; workspaceId: string; seatCount?: number }) {
  const { checkoutUrl } = await postJson('/api/cloud/billing/checkout', params, CheckoutResponse)
  window.location.href = checkoutUrl
}

const PortalResponse = z.object({ portalUrl: z.string() })

/** Opens Dodo's hosted customer portal (manage payment method / cancel) in the current window. */
export async function openBillingPortal(workspaceId: string) {
  const { portalUrl } = await postJson('/api/cloud/billing/portal', { workspaceId }, PortalResponse)
  window.location.href = portalUrl
}

export function setWorkspaceSeats(workspaceId: string, seatCount: number) {
  return postJson(`/api/cloud/workspaces/${workspaceId}/seats`, { seatCount }, z.object({ ok: z.boolean() }), 'PATCH')
}

// Hosted AI mode — the metered, Pro-only alternative to BYOK. BYOK AI never
// calls any of this; it talks to the user's own provider directly with the
// user's own key.
const AiCreditsResponse = z.object({ balance: z.number(), hasAccess: z.boolean() })
export type AiCredits = z.infer<typeof AiCreditsResponse>

export function getAiCredits(workspaceId: string, signal?: AbortSignal) {
  return api(`/api/cloud/ai/credits?workspaceId=${workspaceId}`, AiCreditsResponse, { signal })
}

const AiCompleteResponse = z.object({ sql: z.string() })

/** Sends a prompt + schema context (never the database itself) for a hosted, metered NL→SQL completion. */
export function generateHostedSql(params: { workspaceId: string; prompt: string; schemaContext: string }) {
  return postJson('/api/cloud/ai/complete', params, AiCompleteResponse)
}

const AiCreditsCheckoutResponse = z.object({ checkoutUrl: z.string() })

/** Opens Dodo's hosted checkout for a one-time AI credit top-up pack. */
export async function startAiCreditsCheckout(workspaceId: string, quantity?: number) {
  const { checkoutUrl } = await postJson(
    '/api/cloud/ai/credits/checkout', { workspaceId, quantity }, AiCreditsCheckoutResponse,
  )
  window.location.href = checkoutUrl
}
