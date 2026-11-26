/**
 * OFSCP v0.1 WebSocket schemas — the envelope (`ws/envelope.json`,
 * `ws/types.json`) and every command/event payload under `ws/*.json`.
 *
 * Forward-compatibility (§2.3): the envelope's `type` is an OPEN string, and
 * `data` is arbitrary JSON, so a frame carrying an unknown `type` parses
 * without throwing. {@link WsTypeSchema} is a *non-throwing* helper enum that
 * narrows the set of types known to v0.1 — it is NOT used to gate envelope
 * parsing. Each concrete command/event schema below pins `type` to a literal
 * and validates its own `data` shape; these are for when you already know
 * (e.g. after switching on `type`) which frame you're handling.
 *
 * Split by role: `ws-envelope.ts` (envelope, type enums, heartbeat + error),
 * `ws-commands.ts` (client → server) and `ws-events.ts` (server → client).
 */
export * from "./ws-envelope.ts";
export * from "./ws-commands.ts";
export * from "./ws-events.ts";
