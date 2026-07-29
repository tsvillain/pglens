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

const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
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
