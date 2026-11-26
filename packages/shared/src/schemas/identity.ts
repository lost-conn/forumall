/**
 * OFSCP v0.1 identity / auth schemas — mirrors `defs/identity.json` plus the
 * top-level auth + device-key + user-keys documents.
 */
import { z } from "zod";

import {
  HttpsUriSchema,
  MetadataListSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Profiles & accounts (defs/identity.json)
// ---------------------------------------------------------------------------

/** A user's public profile (`UserProfile`). */
export const UserProfileSchema = z
  .object({
    id: HttpsUriSchema,
    handle: z.string().min(1),
    domain: z.string().min(1),
    displayName: z.string().optional(),
    avatar: HttpsUriSchema.optional(),
    guest: z.boolean().optional(),
    expiresAt: Rfc3339DateTimeSchema.optional(),
    updatedAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type UserProfile = z.infer<typeof UserProfileSchema>;

/** A user account = profile + opaque settings bag (`UserAccount`). */
export const UserAccountSchema = z
  .object({
    profile: UserProfileSchema,
    settings: z.record(z.unknown()),
  })
  .passthrough();
export type UserAccount = z.infer<typeof UserAccountSchema>;

/** A registered device public key (`DeviceKey`). */
export const DeviceKeySchema = z
  .object({
    key_id: z.string().min(1),
    algorithm: z.enum(["Ed25519"]),
    public_key: z.string().min(1),
    created_at: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

// ---------------------------------------------------------------------------
// Auth requests / responses
// ---------------------------------------------------------------------------

/** POST /api/auth/login body. `additionalProperties: false` → `.strict()`. */
export const AuthLoginRequestSchema = z
  .object({
    handle: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

/** POST /api/auth/register body. `additionalProperties: false` → `.strict()`. */
export const AuthRegistrationRequestSchema = z
  .object({
    handle: z.string().min(1),
    password: z.string().min(8),
    recoveryEmail: z.string().email().optional(),
    /**
     * Account invite (OFSCP §4.1.1). Forumall's registration mode is "open", so
     * the token is accepted and ignored — an open provider MUST NOT reject a
     * registration because of its inviteToken.
     */
    inviteToken: z.string().min(1).optional(),
  })
  .strict();
export type AuthRegistrationRequest = z.infer<typeof AuthRegistrationRequestSchema>;

/**
 * POST /api/me/claim body (`guest-claim-request`, OFSCP §4.8.1). Claim follows
 * the registration mode (§4.1.1); Forumall is "open", so `inviteToken` is
 * accepted and ignored.
 */
export const GuestClaimRequestSchema = z
  .object({
    handle: z.string().min(1),
    password: z.string().min(8),
    displayName: z.string().optional(),
    inviteToken: z.string().min(1).optional(),
  })
  .strict();
export type GuestClaimRequest = z.infer<typeof GuestClaimRequestSchema>;

/** Bootstrap-token response from login/register (`auth-bootstrap-response`). */
export const AuthBootstrapResponseSchema = z
  .object({
    bootstrap_token: z.string().min(1),
    token_type: z.literal("bootstrap"),
    expires_in: z.number().int().min(1),
  })
  .passthrough();
export type AuthBootstrapResponse = z.infer<typeof AuthBootstrapResponseSchema>;

/** POST /api/auth/device-keys body (`device-key-registration`). */
export const DeviceKeyRegistrationSchema = z
  .object({
    public_key: z.string().min(1),
    algorithm: z.enum(["Ed25519"]).optional(),
    device_name: z.string(),
  })
  .passthrough();
export type DeviceKeyRegistration = z.infer<typeof DeviceKeyRegistrationSchema>;

/** One entry of `GET /api/auth/device-keys` (§4.7). */
export const DeviceKeyListItemSchema = z
  .object({
    key_id: z.string().min(1),
    algorithm: z.enum(["Ed25519"]),
    public_key: z.string().min(1),
    device_name: z.string(),
    created_at: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type DeviceKeyListItem = z.infer<typeof DeviceKeyListItemSchema>;

/** GET /api/auth/device-keys response (`device-keys-response`, §4.7). */
export const DeviceKeysResponseSchema = z
  .object({ keys: z.array(DeviceKeyListItemSchema) })
  .passthrough();
export type DeviceKeysResponse = z.infer<typeof DeviceKeysResponseSchema>;

/** Device-key registration response (`device-key-response`). */
export const DeviceKeyResponseSchema = z
  .object({
    key_id: z.string().min(1),
    created_at: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type DeviceKeyResponse = z.infer<typeof DeviceKeyResponseSchema>;

/** POST /api/invites/{token}/guest body (`guest-create-request`). */
export const GuestCreateRequestSchema = z
  .object({
    displayName: z.string().optional(),
    public_key: z.string().min(1),
    algorithm: z.enum(["Ed25519"]).optional(),
    device_name: z.string(),
  })
  .passthrough();
export type GuestCreateRequest = z.infer<typeof GuestCreateRequestSchema>;

/** A public key entry as returned by the user-keys endpoint. */
export const UserPublicKeySchema = z
  .object({
    key_id: z.string().min(1),
    algorithm: z.enum(["Ed25519"]),
    public_key: z.string().min(1),
    created_at: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type UserPublicKey = z.infer<typeof UserPublicKeySchema>;

/** GET /.well-known/ofscp/users/{handle}/keys response (`user-keys-response`, §4.6). */
export const UserKeysResponseSchema = z
  .object({
    actor: UserRefSchema,
    keys: z.array(UserPublicKeySchema),
    cache_until: Rfc3339DateTimeSchema,
  })
  .passthrough();
export type UserKeysResponse = z.infer<typeof UserKeysResponseSchema>;

// ---------------------------------------------------------------------------
// Public profile / profile-update (user-public-profile-response, user-update-profile-request)
// ---------------------------------------------------------------------------

/** GET /api/users/{userRef}/profile response (`user-public-profile-response`). */
export const UserPublicProfileResponseSchema = z
  .object({
    id: HttpsUriSchema,
    handle: z.string().min(1),
    domain: z.string().min(1),
    displayName: z.string().optional(),
    avatar: HttpsUriSchema.optional(),
    bio: z.string().optional(),
    updatedAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type UserPublicProfileResponse = z.infer<typeof UserPublicProfileResponseSchema>;

/**
 * PATCH /api/me/profile body (`user-update-profile-request`). `avatar: null`
 * removes the avatar; an absent `avatar` leaves it unchanged (§6.3).
 */
export const UserUpdateProfileRequestSchema = z
  .object({
    displayName: z.string().optional(),
    avatar: HttpsUriSchema.nullable().optional(),
    bio: z.string().optional(),
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type UserUpdateProfileRequest = z.infer<typeof UserUpdateProfileRequestSchema>;

// ---------------------------------------------------------------------------
// GET /api/users/{userRef}/groups response (user-groups-response)
// ---------------------------------------------------------------------------

/** GET /api/users/{userRef}/groups response (`user-groups-response`). */
export const UserGroupsResponseSchema = z
  .object({
    groups: z.array(z.object({ id: HttpsUriSchema }).passthrough()),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type UserGroupsResponse = z.infer<typeof UserGroupsResponseSchema>;

/** POST /api/me/claim and /api/me/merge response (OFSCP §4.8.1). */
export const GuestUpgradeResponseSchema = z
  .object({
    actor: UserRefSchema,
    keyId: z.string().min(1),
    profile: UserProfileSchema,
  })
  .passthrough();
export type GuestUpgradeResponse = z.infer<typeof GuestUpgradeResponseSchema>;
