/**
 * Internal builders for concrete OFSCP WS frame schemas, one per envelope
 * variant of §7.1 *WebSocket message envelope*. Not re-exported from the
 * package barrel.
 *
 *  - {@link wsCommand} — `ws/command-envelope.json`: a client→server command.
 *    `id` is required and `data` is an object; `ts` is optional and its value
 *    is ignored, so the schema places no constraint on it.
 *  - {@link wsEvent} — `ws/event-envelope.json`: a server→client event. `ts`
 *    is required and is an RFC 3339 timestamp.
 *  - {@link wsHeartbeat} — `ws/envelope.json` plus an object `data`: `ping` and
 *    `pong`, which either party sends. `ts` is unconstrained here, as in the
 *    base envelope; a provider-sent heartbeat always carries one (the hub
 *    stamps every outbound frame).
 *
 * Every builder stays `.passthrough()` so unknown top-level keys (and, because
 * the `data` schemas are themselves passthrough, unknown data keys) are
 * preserved (§2.3).
 */
import { z } from "zod";

import { Rfc3339DateTimeSchema } from "./common.ts";

/** The command `ts`: optional, and its value is ignored (§7.1). */
export const ignoredTs = z.unknown().optional();

/** A client→server command (`ws/command-envelope.json`). */
export function wsCommand<T extends z.ZodTypeAny>(type: string, data: T) {
  return z
    .object({
      id: z.string().min(1),
      type: z.literal(type),
      ts: ignoredTs,
      correlationId: z.string().min(1).optional(),
      data,
    })
    .passthrough();
}

/** A server→client event (`ws/event-envelope.json`). */
export function wsEvent<T extends z.ZodTypeAny>(type: string, data: T) {
  return z
    .object({
      id: z.string().min(1),
      type: z.literal(type),
      ts: Rfc3339DateTimeSchema,
      correlationId: z.string().min(1).optional(),
      data,
    })
    .passthrough();
}

/** `ping` / `pong` (`ws/envelope.json` with an object `data`). */
export function wsHeartbeat(type: "ping" | "pong") {
  return z
    .object({
      id: z.string().min(1),
      type: z.literal(type),
      ts: ignoredTs,
      correlationId: z.string().min(1).optional(),
      data: z.object({}).passthrough(),
    })
    .passthrough();
}
