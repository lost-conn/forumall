/**
 * OFSCP v0.1 WebSocket envelope (`ws/envelope.json`), the known-type helper
 * enums (`ws/types.json`), and the heartbeat + `error` frames.
 *
 * Forward-compatibility (§2.3): the envelope's `type` is an OPEN string, and
 * `data` is arbitrary JSON, so a frame carrying an unknown `type` parses
 * without throwing. {@link WsTypeSchema} is a *non-throwing* helper enum that
 * narrows the set of types known to v0.1 — it is NOT used to gate envelope
 * parsing.
 */
import { z } from "zod";

import { JsonValueSchema, Rfc3339DateTimeSchema } from "./common.ts";
import { ignoredTs, wsEvent, wsHeartbeat } from "./ws-frame.ts";

// ---------------------------------------------------------------------------
// Type enums (ws/types.json) — narrowing helpers only, never used to gate parse
// ---------------------------------------------------------------------------

/** Client → server command type strings known to v0.1 (`WsCommandType`). */
export const WsCommandTypeSchema = z.enum([
  "authenticate",
  "subscribe",
  "unsubscribe",
  "message.create",
  "message.update",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "typing.start",
  "typing.stop",
  "presence.subscribe",
  "presence.unsubscribe",
  "presence.set",
  "ping",
  "pong",
]);
export type WsCommandType = z.infer<typeof WsCommandTypeSchema>;

/** Server → client event type strings known to v0.1 (`WsEventType`). */
export const WsEventTypeSchema = z.enum([
  "auth.challenge",
  "authenticated",
  "subscribed",
  "unsubscribed",
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "channel.typing",
  "member.updated",
  "groups.updated",
  "dm.message",
  "dm.reaction",
  "dm.typing",
  "dm.conversation",
  "presence.subscribed",
  "presence.unsubscribed",
  "presence.update",
  "read.updated",
  "notification.created",
  "call.started",
  "call.ended",
  "call.participant",
  "ping",
  "pong",
  "error",
]);
export type WsEventType = z.infer<typeof WsEventTypeSchema>;

/** Every WS type known to v0.1 (`WsType`). Open-world: see file header. */
export const WsTypeSchema = z.enum([
  "authenticate",
  "subscribe",
  "unsubscribe",
  "message.create",
  "message.update",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "typing.start",
  "typing.stop",
  "presence.subscribe",
  "presence.unsubscribe",
  "presence.set",
  "ping",
  "pong",
  "auth.challenge",
  "authenticated",
  "subscribed",
  "unsubscribed",
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "channel.typing",
  "member.updated",
  "groups.updated",
  "dm.message",
  "dm.reaction",
  "dm.typing",
  "dm.conversation",
  "presence.subscribed",
  "presence.unsubscribed",
  "presence.update",
  "read.updated",
  "notification.created",
  "call.started",
  "call.ended",
  "call.participant",
  "error",
]);
export type WsType = z.infer<typeof WsTypeSchema>;

const KNOWN_WS_TYPES: ReadonlySet<string> = new Set(WsTypeSchema.options);

/** True iff `type` is a WS type defined by OFSCP v0.1. Never throws. */
export function isKnownWsType(type: string): type is WsType {
  return KNOWN_WS_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Envelopes (ws/envelope.json, ws/command-envelope.json, ws/event-envelope.json)
// ---------------------------------------------------------------------------

/**
 * The base WS frame (`ws/envelope.json`). `type` is any non-empty string and
 * `data` is arbitrary JSON, so a frame with a novel/unknown `type` parses
 * successfully (§2.3 forward-compat). `ts` is unconstrained here: it is
 * required on events ({@link WsEventEnvelopeSchema}) and optional, with its
 * value ignored, on commands ({@link WsCommandEnvelopeSchema}).
 */
export const WsEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    ts: ignoredTs,
    correlationId: z.string().min(1).optional(),
    data: JsonValueSchema,
  })
  .passthrough();
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

/**
 * A client→server command of any `type` (`ws/command-envelope.json`): `id`
 * required, `data` an object, `ts` optional and ignored (§7.1).
 */
export const WsCommandEnvelopeSchema = WsEnvelopeSchema.extend({
  data: z.record(JsonValueSchema),
});
export type WsCommandEnvelope = z.infer<typeof WsCommandEnvelopeSchema>;

/**
 * A server→client event of any `type` (`ws/event-envelope.json`): `ts` is a
 * required RFC 3339 timestamp (§7.1).
 */
export const WsEventEnvelopeSchema = WsEnvelopeSchema.extend({
  ts: Rfc3339DateTimeSchema,
});
export type WsEventEnvelope = z.infer<typeof WsEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Heartbeat + error
// ---------------------------------------------------------------------------

/** `ping` frame (base envelope; `data` an object, samples send `{}`). */
export const WsPingSchema = wsHeartbeat("ping");
export type WsPing = z.infer<typeof WsPingSchema>;

/** `pong` frame (base envelope; `data` an object, samples send `{}`). */
export const WsPongSchema = wsHeartbeat("pong");
export type WsPong = z.infer<typeof WsPongSchema>;

/** `error` event. */
export const WsErrorSchema = wsEvent(
  "error",
  z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      status: z.number().int().min(100).max(599),
      details: JsonValueSchema.optional(),
    })
    .passthrough(),
);
export type WsError = z.infer<typeof WsErrorSchema>;
