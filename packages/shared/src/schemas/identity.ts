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
  })
  .strict();
export type AuthRegistrationRequest = z.infer<typeof AuthRegistrationRequestSchema>;

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

/** GET /api/users/{userRef}/keys response (`user-keys-response`). */
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

/** PATCH /api/me/profile body (`user-update-profile-request`). */
export const UserUpdateProfileRequestSchema = z
  .object({
    displayName: z.string().optional(),
    avatar: HttpsUriSchema.optional(),
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
