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
import { emptyData, wsFrame } from "./ws-frame.ts";

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
// Envelope (ws/envelope.json) — OPEN `type`, arbitrary `data`
// ---------------------------------------------------------------------------

/**
 * The base WS frame (`envelope`). `type` is any non-empty string and `data` is
 * arbitrary JSON, so a frame with a novel/unknown `type` parses successfully
 * (§2.3 forward-compat).
 */
export const WsEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    ts: Rfc3339DateTimeSchema,
    correlationId: z.string().min(1).optional(),
    data: JsonValueSchema.optional(),
  })
  .passthrough();
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Heartbeat + error
// ---------------------------------------------------------------------------

/** `ping` frame. `data` is optional (samples send `{}`). */
export const WsPingSchema = wsFrame("ping", emptyData);
export type WsPing = z.infer<typeof WsPingSchema>;

/** `pong` frame. `data` is optional (samples send `{}`). */
export const WsPongSchema = wsFrame("pong", emptyData);
export type WsPong = z.infer<typeof WsPongSchema>;

/** `error` event. */
export const WsErrorSchema = wsFrame(
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
