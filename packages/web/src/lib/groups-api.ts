/**
 * Groups / channels / membership / invites API surface (P8 UI).
 *
 * Thin typed wrappers over the authenticated {@link OfscpClient} from the session
 * store for the §5.5 (groups/channels CRUD), §5.7 (membership), §5.6 (invites +
 * guest redeem) and §11.1 (tiers) endpoints the groups UI consumes. Every call
 * goes through the session's signing client so requests carry the §4.4 signature
 * the server's §4.5 middleware accepts.
 *
 * The functions here are intentionally request-shaped (return parsed bodies,
 * throw `OfscpHttpError` on non-2xx) so the screens + TanStack queries stay terse
 * and the server remains the single source of truth for authorization.
 */
import type {
  Channel,
  ChannelCreateRequest,
  ChannelUpdateRequest,
  Group,
  GroupCreateRequest,
  GroupPermissions,
  GroupUpdateRequest,
  Invite,
  InviteCreateRequest,
  JoinRequest,
  Member,
  TiersResponse,
} from "@forumall/shared";
import type { OfscpClient } from "./ofscp-client.ts";

/** Encode an actor `handle@domain` for a `{userRef}` path segment (the `@`). */
export function encodeUserRef(actor: string): string {
  return encodeURIComponent(actor);
}

/**
 * The `GET /api/users/{ref}/groups` (§6.5) response lists group refs as canonical
 * HTTPS URIs (`https://{host}/api/groups/{id}`). Pull the bare group id out.
 */
export function groupIdFromRef(ref: string): string {
  const m = ref.match(/\/api\/groups\/([^/]+)$/);
  return m ? decodeURIComponent(m[1] as string) : ref;
}

interface UserGroupsResponse {
  groups: { id: string }[];
}

/**
 * The ids of the groups the signed-in user belongs to. Uses the self-view of
 * `GET /api/users/{me}/groups` (self-visibility always returns the full set).
 */
export async function fetchMyGroupIds(client: OfscpClient): Promise<string[]> {
  const actor = client.actor;
  if (!actor) throw new Error("not authenticated");
  const res = await client.get<UserGroupsResponse>(`/api/users/${encodeUserRef(actor)}/groups`);
  return (res.data.groups ?? []).map((g) => groupIdFromRef(g.id));
}

/** Fetch one group object (§5.5). */
export async function fetchGroup(client: OfscpClient, groupId: string): Promise<Group> {
  const res = await client.get<Group>(`/api/groups/${groupId}`);
  return res.data;
}

/** Fetch the signed-in user's groups, resolved to full group objects. */
export async function fetchMyGroups(client: OfscpClient): Promise<Group[]> {
  const ids = await fetchMyGroupIds(client);
  const groups = await Promise.all(ids.map((id) => fetchGroup(client, id).catch(() => null)));
  return groups.filter((g): g is Group => g !== null);
}

/** Create a group; the caller becomes `owner` (§5.5). */
export async function createGroup(client: OfscpClient, body: GroupCreateRequest): Promise<Group> {
  const res = await client.post<Group>("/api/groups", body);
  return res.data;
}

/** Patch a group (requires `manage`, §5.5). */
export async function updateGroup(
  client: OfscpClient,
  groupId: string,
  body: GroupUpdateRequest,
): Promise<Group> {
  const res = await client.patch<Group>(`/api/groups/${groupId}`, body);
  return res.data;
}

/** Delete a group (owner only, §5.5). */
export async function deleteGroup(client: OfscpClient, groupId: string): Promise<void> {
  await client.delete(`/api/groups/${groupId}`);
}

/** List the channels visible to the caller in a group (§5.5). */
export async function listChannels(client: OfscpClient, groupId: string): Promise<Channel[]> {
  const res = await client.get<{ items: Channel[] }>(`/api/groups/${groupId}/channels`);
  return res.data.items ?? [];
}

/** Fetch a single channel object (§5.5). Used to label home-feed items. */
export async function fetchChannel(
  client: OfscpClient,
  groupId: string,
  channelId: string,
): Promise<Channel> {
  const res = await client.get<Channel>(`/api/groups/${groupId}/channels/${channelId}`);
  return res.data;
}

/** Create a channel (requires `manage`, §5.5). */
export async function createChannel(
  client: OfscpClient,
  groupId: string,
  body: ChannelCreateRequest,
): Promise<Channel> {
  const res = await client.post<Channel>(`/api/groups/${groupId}/channels`, body);
  return res.data;
}

/** Patch a channel (requires `manage`, §5.5). */
export async function updateChannel(
  client: OfscpClient,
  groupId: string,
  channelId: string,
  body: ChannelUpdateRequest,
): Promise<Channel> {
  const res = await client.patch<Channel>(`/api/groups/${groupId}/channels/${channelId}`, body);
  return res.data;
}

/** Delete a channel (requires `manage`, §5.5). */
export async function deleteChannel(
  client: OfscpClient,
  groupId: string,
  channelId: string,
): Promise<void> {
  await client.delete(`/api/groups/${groupId}/channels/${channelId}`);
}

/** The result of joining a group (the new `Member`, a pending `JoinRequest`, or 403). */
export type JoinOutcome =
  | { kind: "member"; member: Member }
  | { kind: "request"; request: JoinRequest }
  | { kind: "invite-required" };

/** Join a group per its policy (§5.7): open → member, request → pending, invite → 403. */
export async function joinGroup(
  client: OfscpClient,
  groupId: string,
  message?: string,
): Promise<JoinOutcome> {
  try {
    const res = await client.post<Member | JoinRequest>(
      `/api/groups/${groupId}/join`,
      message ? { message } : {},
    );
    if (res.status === 202) {
      return { kind: "request", request: res.data as JoinRequest };
    }
    return { kind: "member", member: res.data as Member };
  } catch (err) {
    // 403 → invite-only; surface a typed outcome rather than throwing.
    if (typeof err === "object" && err !== null && "status" in err) {
      if ((err as { status: number }).status === 403) return { kind: "invite-required" };
    }
    throw err;
  }
}

/** Leave a group (§5.7). The owner must transfer ownership first (409). */
export async function leaveGroup(client: OfscpClient, groupId: string): Promise<void> {
  await client.post(`/api/groups/${groupId}/leave`, {});
}

/** List a group's members (first page; §5.7/§7.2). */
export async function listMembers(client: OfscpClient, groupId: string): Promise<Member[]> {
  const res = await client.get<{ items: Member[]; page?: { nextCursor?: string | null } }>(
    `/api/groups/${groupId}/members`,
  );
  return res.data.items ?? [];
}

/** Change a member's role (manage; owner transfer is owner-only, §5.7). */
export async function setMemberRole(
  client: OfscpClient,
  groupId: string,
  userRef: string,
  role: string,
): Promise<Member> {
  const res = await client.patch<Member>(
    `/api/groups/${groupId}/members/${encodeUserRef(userRef)}`,
    { role },
  );
  return res.data;
}

/** Remove (kick) a member (moderate, §5.7). */
export async function removeMember(
  client: OfscpClient,
  groupId: string,
  userRef: string,
): Promise<void> {
  await client.delete(`/api/groups/${groupId}/members/${encodeUserRef(userRef)}`);
}

/** List pending join requests (manage/moderate, §5.7). */
export async function listJoinRequests(
  client: OfscpClient,
  groupId: string,
): Promise<JoinRequest[]> {
  const res = await client.get<{ items: JoinRequest[] }>(`/api/groups/${groupId}/requests`);
  return res.data.items ?? [];
}

/** Approve a pending join request (manage/moderate, §5.7). */
export async function approveJoinRequest(
  client: OfscpClient,
  groupId: string,
  requestId: string,
): Promise<Member> {
  const res = await client.post<Member>(`/api/groups/${groupId}/requests/${requestId}/approve`, {});
  return res.data;
}

/** Deny a pending join request (manage/moderate, §5.7). */
export async function denyJoinRequest(
  client: OfscpClient,
  groupId: string,
  requestId: string,
): Promise<void> {
  await client.post(`/api/groups/${groupId}/requests/${requestId}/deny`, {});
}

/** An invite plus its shareable link (the server adds `link` to the §5.6 body). */
export type InviteWithLink = Invite & { link?: string };

/** Mint an invite for a group (manage, §5.6). */
export async function createInvite(
  client: OfscpClient,
  groupId: string,
  body: InviteCreateRequest,
): Promise<InviteWithLink> {
  const res = await client.post<InviteWithLink>(`/api/groups/${groupId}/invites`, body);
  return res.data;
}

/** List a group's invites (manage, §5.6). */
export async function listInvites(client: OfscpClient, groupId: string): Promise<Invite[]> {
  const res = await client.get<{ items: Invite[] }>(`/api/groups/${groupId}/invites`);
  return res.data.items ?? [];
}

/** Revoke an invite (manage, §5.6). */
export async function deleteInvite(
  client: OfscpClient,
  groupId: string,
  inviteId: string,
): Promise<void> {
  await client.delete(`/api/groups/${groupId}/invites/${inviteId}`);
}

/** Redeem an invite as an existing signed-in account (§5.6). */
export interface RedeemResult {
  groupId: string;
  channelId?: string;
  role?: string;
}
export async function redeemInvite(client: OfscpClient, token: string): Promise<RedeemResult> {
  const res = await client.post<RedeemResult>(`/api/invites/${token}/redeem`, {});
  return res.data;
}

/** Fetch the canonical tier catalogue (§11.1). Public; uses the signed client. */
export async function fetchTiers(client: OfscpClient): Promise<TiersResponse> {
  const res = await client.get<TiersResponse>("/api/tiers");
  return res.data;
}

// ---------------------------------------------------------------------------
// Client-side permission reflection (UI hints only; the server is authoritative)
// ---------------------------------------------------------------------------

/** The canonical roles (§5.2); always available alongside a group's catalogue. */
export const CANONICAL_ROLES = ["owner", "admin", "member", "guest"] as const;

/**
 * Mirror of the server's §5.2 resolver (`provider/permissions.ts`):
 * exact-membership. Owner is always allowed; otherwise the action is permitted
 * iff the actor's role is listed verbatim for that action (no rank inheritance).
 * Used ONLY to decide which controls to offer — the server re-checks every
 * mutation.
 */
export function can(
  action: "post" | "moderate" | "manage" | string,
  role: string | undefined,
  permissions: GroupPermissions | undefined,
): boolean {
  if (role === "owner") return true;
  if (role == null) return false;
  return permissions?.[action]?.includes(role) ?? false;
}

/**
 * The set of actions a role is granted (its permission set, §5.2): every action
 * whose list names the role. Owner implicitly holds every action in the map.
 * Mirror of the server's `grantsOf`.
 */
export function grantsOf(role: string, permissions: GroupPermissions | undefined): Set<string> {
  const actions = Object.keys(permissions ?? {});
  if (role === "owner") return new Set(actions);
  const held = new Set<string>();
  for (const action of actions) {
    if (permissions?.[action]?.includes(role)) held.add(action);
  }
  return held;
}

/**
 * The §5.7 subset (self-protect) rule mirror: does `callerRole` hold every
 * permission `targetRole` holds? Backs the UI hints for kick / role-change.
 */
export function roleHoldsAll(
  callerRole: string | undefined,
  targetRole: string,
  permissions: GroupPermissions | undefined,
): boolean {
  if (callerRole === "owner") return true;
  if (callerRole == null || targetRole === "owner") return false;
  const caller = grantsOf(callerRole, permissions);
  for (const action of grantsOf(targetRole, permissions)) {
    if (!caller.has(action)) return false;
  }
  return true;
}
