/**
 * OFSCP v0.1 group / channel / membership schemas — mirrors `defs/groups.json`
 * plus the top-level group/channel/invite/member/join-request documents and
 * their create/update request bodies. Includes the tiers + providers responses.
 */
import { z } from "zod";

import {
  HttpsUriSchema,
  MetadataListSchema,
  Rfc3339DateTimeSchema,
  TierSchema,
  UserRefSchema,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Enums / shared (defs/groups.json)
// ---------------------------------------------------------------------------

/** Membership role — open string; canonical: owner/admin/member/guest (`Role`). */
export const RoleSchema = z.string().min(1);
export type Role = z.infer<typeof RoleSchema>;

/**
 * A role a group defines (`RoleDefinition`, §5.2). Declares a role's name + UI
 * hints so clients can offer it for assignment and render it — including custom
 * roles beyond canonical owner/admin/member/guest. A role's *permissions* are
 * resolved from the group's `permissions` map, not from this object.
 */
export const RoleDefinitionSchema = z
  .object({
    name: RoleSchema,
    label: z.string().optional(),
    color: z.string().optional(),
  })
  .passthrough();
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

/** Group join policy (`JoinPolicy`). */
export const JoinPolicySchema = z.enum(["open", "request", "invite"]);
export type JoinPolicy = z.infer<typeof JoinPolicySchema>;

/** Channel kind (`ChannelType`). */
export const ChannelTypeSchema = z.enum(["text", "call"]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

/**
 * Action → permitted-roles map (`GroupPermissions`). Open action set. Each list
 * is the **exact** set of roles allowed to perform the action (no rank
 * inheritance, §5.2); `owner` is the implicit super-role and always allowed.
 */
export const GroupPermissionsSchema = z
  .object({
    post: z.array(RoleSchema).optional(),
    moderate: z.array(RoleSchema).optional(),
    manage: z.array(RoleSchema).optional(),
  })
  .catchall(z.array(RoleSchema));
export type GroupPermissions = z.infer<typeof GroupPermissionsSchema>;

/**
 * Per-channel permission overrides (`ChannelPermissions`, §5.2.1). Same
 * action→roles shape as group permissions, refining them for one channel.
 * Grant actions (`view`, `post:message`, `post:memo`, `post:article`, `react`)
 * are rank-inherited; `replyOnly` restricts low-rank actors to posting replies;
 * `replyOnlyTo` constrains the parent message type a reply-restricted actor may
 * reply to. Open action set (catchall) for forward-compat (§2.3).
 */
export const ChannelPermissionsSchema = z
  .object({
    view: z.array(RoleSchema).optional(),
    "post:message": z.array(RoleSchema).optional(),
    "post:memo": z.array(RoleSchema).optional(),
    "post:article": z.array(RoleSchema).optional(),
    react: z.array(RoleSchema).optional(),
    replyOnly: z.array(RoleSchema).optional(),
    replyOnlyTo: z.array(z.enum(["message", "memo", "article"])).optional(),
  })
  .catchall(z.array(z.string().min(1)));
export type ChannelPermissions = z.infer<typeof ChannelPermissionsSchema>;

/** Derived call-status projection for a call channel (`CallSummary`). */
export const CallSummarySchema = z
  .object({
    active: z.boolean(),
    participants: z.array(UserRefSchema).optional(),
  })
  .passthrough();
export type CallSummary = z.infer<typeof CallSummarySchema>;

// ---------------------------------------------------------------------------
// Group (group.json → defs/groups.json#/$defs/Group)
// ---------------------------------------------------------------------------

/**
 * The caller's own membership of a group (`Membership`, §5.5): returned as
 * `Group.membership` by GET /api/groups/{groupId} to a signed member.
 * Authoritative.
 */
export const MembershipSchema = z
  .object({
    role: RoleSchema,
    joinedAt: Rfc3339DateTimeSchema,
    /** The caller's group-scoped display name, if set (§5.7). */
    displayNameOverride: z.string().optional(),
  })
  .passthrough();
export type Membership = z.infer<typeof MembershipSchema>;

/**
 * Canonical group object (`Group`). `membership` is present only in an answer
 * to a request signed by a member (§5.5); its absence does not prove the
 * caller is not a member.
 */
export const GroupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    avatar: HttpsUriSchema.optional(),
    owner: UserRefSchema,
    joinPolicy: JoinPolicySchema,
    tier: TierSchema,
    permissions: GroupPermissionsSchema,
    roles: z.array(RoleDefinitionSchema).optional(),
    membership: MembershipSchema.optional(),
    createdAt: Rfc3339DateTimeSchema,
    updatedAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Group = z.infer<typeof GroupSchema>;

/** POST /api/groups body (`group-create-request`). */
export const GroupCreateRequestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    avatar: HttpsUriSchema.optional(),
    tier: TierSchema.optional(),
    joinPolicy: JoinPolicySchema.optional(),
    permissions: GroupPermissionsSchema.optional(),
    roles: z.array(RoleDefinitionSchema).optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type GroupCreateRequest = z.infer<typeof GroupCreateRequestSchema>;

/** PATCH /api/groups/{groupId} body (`group-update-request`). All optional. */
export const GroupUpdateRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    avatar: HttpsUriSchema.optional(),
    tier: TierSchema.optional(),
    joinPolicy: JoinPolicySchema.optional(),
    permissions: GroupPermissionsSchema.optional(),
    roles: z.array(RoleDefinitionSchema).optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type GroupUpdateRequest = z.infer<typeof GroupUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// Channel (channel.json → defs/groups.json#/$defs/Channel)
// ---------------------------------------------------------------------------

/** Canonical channel object (`Channel`). */
export const ChannelSchema = z
  .object({
    id: z.string().min(1),
    groupId: z.string().min(1),
    name: z.string().optional(),
    type: ChannelTypeSchema,
    tier: TierSchema,
    topic: z.string().optional(),
    tags: z.array(z.string()).optional(),
    permissions: ChannelPermissionsSchema.optional(),
    call: CallSummarySchema.optional(),
    createdAt: Rfc3339DateTimeSchema,
    updatedAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Channel = z.infer<typeof ChannelSchema>;

/** POST /api/groups/{groupId}/channels body (`channel-create-request`). */
export const ChannelCreateRequestSchema = z
  .object({
    name: z.string().optional(),
    type: ChannelTypeSchema,
    tier: TierSchema.optional(),
    topic: z.string().optional(),
    tags: z.array(z.string()).optional(),
    permissions: ChannelPermissionsSchema.optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type ChannelCreateRequest = z.infer<typeof ChannelCreateRequestSchema>;

/** PATCH channel body (`channel-update-request`). All optional; type immutable. */
export const ChannelUpdateRequestSchema = z
  .object({
    name: z.string().optional(),
    tier: TierSchema.optional(),
    topic: z.string().optional(),
    tags: z.array(z.string()).optional(),
    permissions: ChannelPermissionsSchema.optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type ChannelUpdateRequest = z.infer<typeof ChannelUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// Invite / Member / JoinRequest
// ---------------------------------------------------------------------------

/** A join link / invite token (`Invite`). */
export const InviteSchema = z
  .object({
    id: z.string().min(1),
    groupId: z.string().min(1),
    channelId: z.string().min(1).optional(),
    token: z.string().min(1),
    role: RoleSchema.optional(),
    grantsGuest: z.boolean().optional(),
    maxUses: z.number().int().min(1).optional(),
    uses: z.number().int().min(0),
    expiresAt: Rfc3339DateTimeSchema.optional(),
    createdBy: UserRefSchema,
    createdAt: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type Invite = z.infer<typeof InviteSchema>;

/** POST /api/groups/{groupId}/invites body (`invite-create-request`). */
export const InviteCreateRequestSchema = z
  .object({
    channelId: z.string().min(1).optional(),
    role: RoleSchema.optional(),
    grantsGuest: z.boolean().optional(),
    maxUses: z.number().int().min(1).optional(),
    expiresAt: Rfc3339DateTimeSchema.optional(),
  })
  .passthrough();
export type InviteCreateRequest = z.infer<typeof InviteCreateRequestSchema>;

/** A group member entry (`Member`). */
export const MemberSchema = z
  .object({
    user: UserRefSchema,
    role: RoleSchema,
    joinedAt: Rfc3339DateTimeSchema,
    /**
     * Per-group display-name override (Discord-server-nickname style): when set,
     * it overrides the member's GLOBAL `UserProfile.displayName` within THIS
     * group only. Absent/null → use the global name. Conformance-safe: `Member`
     * is `additionalProperties:true` and this schema stays `.passthrough()`, so
     * the field is forward-compatible.
     */
    displayNameOverride: z.string().optional(),
  })
  .passthrough();
export type Member = z.infer<typeof MemberSchema>;

/** A pending request to join a `request`-policy group (`JoinRequest`). */
export const JoinRequestSchema = z
  .object({
    id: z.string().min(1),
    groupId: z.string().min(1),
    user: UserRefSchema,
    state: z.enum(["pending", "approved", "denied"]),
    message: z.string().optional(),
    requestedAt: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

// ---------------------------------------------------------------------------
// My groups (§5.7): group-pointer, group-pointer-request, group-pointers-response
// ---------------------------------------------------------------------------

/**
 * An entry in the user's group list at their home provider (`GroupPointer`,
 * §5.7 My groups): a group the provider hosts and the user belongs to, or a
 * pointer the user's client recorded for a remote group. `group` is the
 * group's object URI, `https://{authority}/api/groups/{groupId}`. `role` is
 * the current role for a hosted group, and for a remote group a client-recorded
 * hint that MAY be stale or absent (the authority is `Group.membership`).
 */
export const GroupPointerSchema = z
  .object({
    group: HttpsUriSchema,
    role: RoleSchema.optional(),
    updatedAt: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type GroupPointer = z.infer<typeof GroupPointerSchema>;

/**
 * PUT /api/me/groups/{groupRef} body (`group-pointer-request`): optional; its
 * `role` is stored as a non-authoritative hint.
 */
export const GroupPointerRequestSchema = z
  .object({
    role: RoleSchema.optional(),
  })
  .passthrough();
export type GroupPointerRequest = z.infer<typeof GroupPointerRequestSchema>;

/** GET /api/me/groups response (`group-pointers-response`). */
export const GroupPointersResponseSchema = z
  .object({
    groups: z.array(GroupPointerSchema),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type GroupPointersResponse = z.infer<typeof GroupPointersResponseSchema>;

// ---------------------------------------------------------------------------
// tiers-response / providers-response
// ---------------------------------------------------------------------------

/** GET /api/tiers response (`tiers-response`). */
export const TiersResponseSchema = z
  .object({
    tiers: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          description: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type TiersResponse = z.infer<typeof TiersResponseSchema>;

/** GET /api/providers response (`providers-response`). */
export const ProvidersResponseSchema = z
  .object({
    providers: z.array(
      z
        .object({
          domain: z.string().min(1),
          name: z.string().optional(),
          addedAt: Rfc3339DateTimeSchema.optional(),
        })
        .passthrough(),
    ),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;
