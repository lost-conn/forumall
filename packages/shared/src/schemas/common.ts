/**
 * OFSCP v0.1 common primitives — mirrors `schemas/v0.1/defs/common.json` and the
 * shared `objects.json` / `privacy.json` / `identity.json#UserRef` definitions.
 *
 * These are the leaf types every other schema composes from. Per spec §2.3,
 * consumers MUST ignore (and SHOULD preserve) unknown JSON fields, so every
 * object schema in this package is `.passthrough()`. zod v3's `.passthrough()`
 * keeps unknown keys in the parsed output rather than stripping them.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// String primitives (defs/common.json)
// ---------------------------------------------------------------------------

/** Absolute HTTPS URI identifier (`HttpsUri`). */
export const HttpsUriSchema = z.string().regex(/^https:\/\//, {
  message: "must be an absolute https:// URI",
});
export type HttpsUri = z.infer<typeof HttpsUriSchema>;

/**
 * RFC 3339 / ISO-8601 timestamp with timezone (`Rfc3339DateTime`). The JSON
 * Schema only tags `format: date-time` (advisory in draft 2020-12); we keep it
 * a plain string so valid samples never fail on formatting nuances.
 */
export const Rfc3339DateTimeSchema = z.string().min(1);
export type Rfc3339DateTime = z.infer<typeof Rfc3339DateTimeSchema>;

/** IANA media type, best-effort (`MimeType`). */
export const MimeTypeSchema = z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/, {
  message: "must look like an IANA media type",
});
export type MimeType = z.infer<typeof MimeTypeSchema>;

/** Opaque pagination cursor (`OpaqueCursor`). */
export const OpaqueCursorSchema = z.string().min(1);
export type OpaqueCursor = z.infer<typeof OpaqueCursorSchema>;

/** Deterministic DM conversation id (`DmId`), `dm_` + 64 lowercase hex chars. */
export const DmIdSchema = z.string().regex(/^dm_[0-9a-f]{64}$/, {
  message: "must be dm_ followed by 64 lowercase hex chars",
});
export type DmId = z.infer<typeof DmIdSchema>;

/**
 * Access/discoverability tier (`Tier`). Open string — providers MAY define
 * tiers beyond the canonical `private`/`group`/`public`/`discoverable`.
 */
export const TierSchema = z.string().min(1);
export type Tier = z.infer<typeof TierSchema>;

/** Profile/membership/presence visibility policy (`VisibilityPolicy`). */
export const VisibilityPolicySchema = z.enum([
  "public",
  "authenticated",
  "sharedGroups",
  "contacts",
  "nobody",
]);
export type VisibilityPolicy = z.infer<typeof VisibilityPolicySchema>;

// ---------------------------------------------------------------------------
// UserRef (identity.json#/$defs/UserRef)
// ---------------------------------------------------------------------------

/**
 * User reference. Canonical actor form is `handle@domain` (no leading `@`); an
 * HTTPS URI MAY also be used. Clients MUST treat the value as opaque, so we
 * accept either shape and otherwise keep it a string.
 */
export const UserRefSchema = z.union([
  HttpsUriSchema,
  z.string().regex(/^[^@\s]+@[^@\s]+$/, {
    message: "must be handle@domain or an https URI",
  }),
]);
export type UserRef = z.infer<typeof UserRefSchema>;

// ---------------------------------------------------------------------------
// Arbitrary-JSON value (used by metadata payloads, ws envelope `data`, etc.)
// ---------------------------------------------------------------------------

/** Any JSON value: object | array | string | number | boolean | null. */
export const JsonValueSchema: z.ZodTypeAny = z.union([
  z.record(z.unknown()),
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type JsonValue = z.infer<typeof JsonValueSchema>;

// ---------------------------------------------------------------------------
// Metadata (objects.json#/$defs/MetadataObject + MetadataList)
// ---------------------------------------------------------------------------

/** Extension metadata object (`MetadataObject`). Unknown schemas are ignored. */
export const MetadataObjectSchema = z
  .object({
    schema: HttpsUriSchema,
    version: z.string().min(1),
    data: JsonValueSchema,
  })
  .passthrough();
export type MetadataObject = z.infer<typeof MetadataObjectSchema>;

/** Array of extension metadata objects (`MetadataList`). */
export const MetadataListSchema = z.array(MetadataObjectSchema);
export type MetadataList = z.infer<typeof MetadataListSchema>;

// ---------------------------------------------------------------------------
// Attachment (objects.json#/$defs/Attachment)
// ---------------------------------------------------------------------------

/** Message attachment (`Attachment`). */
export const AttachmentSchema = z
  .object({
    id: z.string().min(1),
    mime: MimeTypeSchema,
    url: HttpsUriSchema,
    size: z.number().int().min(0),
    filename: z.string().optional(),
    hash: z.string().optional(),
    width: z.number().int().min(0).optional(),
    height: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
  })
  .passthrough();
export type Attachment = z.infer<typeof AttachmentSchema>;

// ---------------------------------------------------------------------------
// IceServer (common.json#/$defs/IceServer)
// ---------------------------------------------------------------------------

/** WebRTC ICE (STUN/TURN) server config (`IceServer`). */
export const IceServerSchema = z
  .object({
    urls: z.union([z.string().min(1), z.array(z.string().min(1))]),
    username: z.string().optional(),
    credential: z.string().optional(),
  })
  .passthrough();
export type IceServer = z.infer<typeof IceServerSchema>;
