/**
 * OFSCP v0.1 miscellaneous object schemas — problem-details (RFC 7807), the
 * call signaling/session/state shapes (calls are deferred but the shapes are
 * modeled), notifications, and the provider discovery document.
 */
import { z } from "zod";

import {
  HttpsUriSchema,
  IceServerSchema,
  MetadataListSchema,
  Rfc3339DateTimeSchema,
  TierSchema,
  UserRefSchema,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Problem details (problem-details.json — RFC 7807 + OFSCP extension)
// ---------------------------------------------------------------------------

/** RFC 7807 problem details with the OFSCP `errorCode` extension. */
export const ProblemDetailsSchema = z
  .object({
    type: HttpsUriSchema,
    title: z.string(),
    status: z.number().int().min(100).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .passthrough();
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

// ---------------------------------------------------------------------------
// Call signaling payloads (call-offer / call-answer / call-ice)
// ---------------------------------------------------------------------------

/** WebRTC offer SDP payload (`call-offer`). */
export const CallOfferSchema = z
  .object({
    sdp: z.string().min(1),
    type: z.enum(["offer"]).optional(),
  })
  .passthrough();
export type CallOffer = z.infer<typeof CallOfferSchema>;

/** WebRTC answer SDP payload (`call-answer`). */
export const CallAnswerSchema = z
  .object({
    sdp: z.string().min(1),
    type: z.enum(["answer"]).optional(),
  })
  .passthrough();
export type CallAnswer = z.infer<typeof CallAnswerSchema>;

/** WebRTC ICE candidate payload (`call-ice`). */
export const CallIceSchema = z
  .object({
    candidate: z.string().min(1),
    sdpMid: z.string().optional(),
    sdpMLineIndex: z.number().int().min(0).optional(),
  })
  .passthrough();
export type CallIce = z.infer<typeof CallIceSchema>;

// ---------------------------------------------------------------------------
// Call channel state + session (call-channel-state / call-session)
// ---------------------------------------------------------------------------

/** Per-participant media descriptors within a call. */
export const CallParticipantMediaSchema = z
  .object({
    audio: z.string().optional(),
    video: z.string().optional(),
  })
  .passthrough();
export type CallParticipantMedia = z.infer<typeof CallParticipantMediaSchema>;

/** A participant in a call's channel state. */
export const CallStateParticipantSchema = z
  .object({
    user: UserRefSchema,
    role: z.string().min(1),
    media: CallParticipantMediaSchema,
  })
  .passthrough();
export type CallStateParticipant = z.infer<typeof CallStateParticipantSchema>;

/** Authoritative call state for a channel (the `call` sub-object). */
export const CallStateSchema = z
  .object({
    state: z.enum(["inactive", "active"]),
    participants: z.array(CallStateParticipantSchema),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type CallState = z.infer<typeof CallStateSchema>;

/** Call channel state document (`call-channel-state`). */
export const CallChannelStateSchema = z
  .object({
    channel: z.string().min(1),
    call: CallStateSchema,
  })
  .passthrough();
export type CallChannelState = z.infer<typeof CallChannelStateSchema>;

/** Response from call start/join (`call-session`): state + ICE servers. */
export const CallSessionSchema = z
  .object({
    channel: z.string().min(1),
    call: CallStateSchema,
    iceServers: z.array(IceServerSchema),
  })
  .passthrough();
export type CallSession = z.infer<typeof CallSessionSchema>;

// ---------------------------------------------------------------------------
// Notifications (notifications-webhook-registration / notifications-delivery)
// ---------------------------------------------------------------------------

/** POST /api/notifications/endpoints body (`notifications-webhook-registration`). */
export const NotificationsWebhookRegistrationSchema = z
  .object({
    type: z.string().min(1),
    target: HttpsUriSchema,
    events: z.array(z.string().min(1)),
  })
  .passthrough();
export type NotificationsWebhookRegistration = z.infer<
  typeof NotificationsWebhookRegistrationSchema
>;

/** Signed notification delivery payload (`notifications-delivery`). */
export const NotificationsDeliverySchema = z
  .object({
    event: z.string().min(1),
    resource: z
      .object({
        id: z.string().min(1),
        channel: z.string().min(1).optional(),
      })
      .passthrough(),
    provider: z.string().min(1),
    signature: z.string().min(1),
  })
  .passthrough();
export type NotificationsDelivery = z.infer<typeof NotificationsDeliverySchema>;

// ---------------------------------------------------------------------------
// Provider discovery document (provider-discovery.json)
// ---------------------------------------------------------------------------

const ProviderSoftwareSchema = z
  .object({
    name: z.string(),
    version: z.string(),
  })
  .passthrough();

const ProviderAuthenticationSchema = z
  .object({
    login_endpoint: HttpsUriSchema,
    registration_endpoint: HttpsUriSchema.optional(),
  })
  .passthrough();

/** Provider signing key entry; `created_at` optional here (unlike user keys). */
const ProviderPublicKeySchema = z
  .object({
    key_id: z.string().min(1),
    algorithm: z.enum(["Ed25519"]),
    public_key: z.string().min(1),
    created_at: Rfc3339DateTimeSchema.optional(),
  })
  .passthrough();

const ProviderInfoSchema = z
  .object({
    domain: z.string().min(1),
    protocolVersion: z
      .string()
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    software: ProviderSoftwareSchema,
    contact: z.string(),
    authentication: ProviderAuthenticationSchema,
    publicKeys: z.array(ProviderPublicKeySchema).min(1),
  })
  .passthrough();

const ProviderCapabilitiesSchema = z
  .object({
    messageTypes: z.array(z.enum(["memo", "article", "message", "reaction"])).optional(),
    tiers: z.array(TierSchema).optional(),
    metadataSchemas: z
      .array(z.object({ id: z.string().min(1), uri: HttpsUriSchema }).passthrough())
      .optional(),
    limits: z
      .object({ maxUploadBytes: z.number().int().min(0).optional() })
      .passthrough()
      .optional(),
    federation: z
      .object({
        realtimeDelivery: z.enum(["direct-ws", "none"]).optional(),
      })
      .passthrough()
      .optional(),
    discovery: z
      .object({
        sharesKnownProviders: z.boolean().optional(),
        discoverFeed: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** `.well-known/ofscp-provider` discovery document (`provider-discovery`). */
export const ProviderDiscoverySchema = z
  .object({
    provider: ProviderInfoSchema,
    capabilities: ProviderCapabilitiesSchema,
    // Deprecated; clients MUST ignore it if present.
    endpoints: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type ProviderDiscovery = z.infer<typeof ProviderDiscoverySchema>;
