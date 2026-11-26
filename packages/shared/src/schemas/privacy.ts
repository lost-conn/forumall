/**
 * OFSCP v0.1 privacy / social schemas — privacy-settings, presence, contacts,
 * follows, and the cross-provider discover feed.
 */
import { z } from "zod";

import {
  MetadataListSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
  VisibilityPolicySchema,
} from "./common.ts";
import { ContentSchema, PageInfoSchema } from "./messaging.ts";

// ---------------------------------------------------------------------------
// Privacy settings (privacy-settings + update request)
// ---------------------------------------------------------------------------

/** A user's privacy settings (`privacy-settings`). */
export const PrivacySettingsSchema = z
  .object({
    presenceVisibility: VisibilityPolicySchema,
    profileVisibility: VisibilityPolicySchema,
    membershipVisibility: VisibilityPolicySchema,
    /** Always-allowed user references, overriding the policies (§6.1). */
    allowList: z.array(UserRefSchema).optional(),
    /** Always-denied user references, overriding the policies (§6.1). */
    denyList: z.array(UserRefSchema).optional(),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;

/**
 * PUT /api/me/privacy body (`privacy-settings-update-request`). A partial update
 * (§6.6): every field is optional, an absent field is left unchanged, and `[]`
 * clears a list.
 */
export const PrivacySettingsUpdateRequestSchema = z
  .object({
    presenceVisibility: VisibilityPolicySchema.optional(),
    profileVisibility: VisibilityPolicySchema.optional(),
    membershipVisibility: VisibilityPolicySchema.optional(),
    allowList: z.array(UserRefSchema).optional(),
    denyList: z.array(UserRefSchema).optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type PrivacySettingsUpdateRequest = z.infer<typeof PrivacySettingsUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// Presence (presence + update request)
// ---------------------------------------------------------------------------

/** A user's presence (`presence`). */
export const PresenceSchema = z
  .object({
    availability: z.enum(["online", "away", "dnd", "offline"]),
    status: z.string().optional(),
    lastSeen: Rfc3339DateTimeSchema.optional(),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Presence = z.infer<typeof PresenceSchema>;

/** The presence values a client may set; `offline` is connection-derived (§7.5). */
export const SettableAvailabilitySchema = z.enum(["online", "away", "dnd"]);
export type SettableAvailability = z.infer<typeof SettableAvailabilitySchema>;

/**
 * PUT /api/me/presence body (`presence-update-request`), also the `data` of the
 * WS `presence.set` command (§7.5). A full replace (§6.4): `availability` is
 * required and cannot be `offline`, an absent `status` clears it, and
 * `lastSeen` is provider-set, so it is not part of the request.
 */
export const PresenceUpdateRequestSchema = z
  .object({
    availability: SettableAvailabilitySchema,
    status: z.string().optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type PresenceUpdateRequest = z.infer<typeof PresenceUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// Contacts (contact, contact-create-request, contact-event, contacts-response)
// ---------------------------------------------------------------------------

/** A contact relationship entry (`contact`). */
export const ContactSchema = z
  .object({
    user: UserRefSchema,
    state: z.enum(["pending", "accepted"]),
    direction: z.enum(["outgoing", "incoming"]).optional(),
    createdAt: Rfc3339DateTimeSchema,
    updatedAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Contact = z.infer<typeof ContactSchema>;

/** POST /api/me/contacts body (`contact-create-request`). */
export const ContactCreateRequestSchema = z
  .object({
    user: UserRefSchema,
  })
  .passthrough();
export type ContactCreateRequest = z.infer<typeof ContactCreateRequestSchema>;

/** POST /api/federation/contacts body (`contact-event`). */
export const ContactEventSchema = z
  .object({
    action: z.enum(["request", "accept", "remove"]),
    from: UserRefSchema,
    to: UserRefSchema,
  })
  .passthrough();
export type ContactEvent = z.infer<typeof ContactEventSchema>;

/** GET /api/me/contacts response (`contacts-response`). */
export const ContactsResponseSchema = z
  .object({
    contacts: z.array(ContactSchema),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type ContactsResponse = z.infer<typeof ContactsResponseSchema>;

// ---------------------------------------------------------------------------
// Follows (follow, follow-create-request, follows-response)
// ---------------------------------------------------------------------------

/** A channel the authenticated user follows (`follow`). */
export const FollowSchema = z
  .object({
    channel: z.string().min(1),
    groupId: z.string().min(1).optional(),
    createdAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Follow = z.infer<typeof FollowSchema>;

/** POST /api/me/follows body (`follow-create-request`). */
export const FollowCreateRequestSchema = z
  .object({
    channel: z.string().min(1),
    groupId: z.string().min(1).optional(),
  })
  .passthrough();
export type FollowCreateRequest = z.infer<typeof FollowCreateRequestSchema>;

/** GET /api/me/follows response (`follows-response`). */
export const FollowsResponseSchema = z
  .object({
    follows: z.array(FollowSchema),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type FollowsResponse = z.infer<typeof FollowsResponseSchema>;

// ---------------------------------------------------------------------------
// Discover feed (discover-response)
// ---------------------------------------------------------------------------

/** Cached, non-authoritative message preview in a discover item. */
export const DiscoverSampleSchema = z
  .object({
    id: z.string().min(1),
    author: UserRefSchema.optional(),
    createdAt: Rfc3339DateTimeSchema.optional(),
    content: ContentSchema.optional(),
  })
  .passthrough();
export type DiscoverSample = z.infer<typeof DiscoverSampleSchema>;

/** A single recommended channel pointer in the discover feed. */
export const DiscoverItemSchema = z
  .object({
    channel: z.string().min(1),
    groupId: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    sample: DiscoverSampleSchema.optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type DiscoverItem = z.infer<typeof DiscoverItemSchema>;

/** GET /api/discover response (`discover-response`). Paged channel pointers. */
export const DiscoverResponseSchema = z
  .object({
    items: z.array(DiscoverItemSchema),
    page: PageInfoSchema,
  })
  .passthrough();
export type DiscoverResponse = z.infer<typeof DiscoverResponseSchema>;
