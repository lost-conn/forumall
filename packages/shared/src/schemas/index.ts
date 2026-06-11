/**
 * OFSCP v0.1 object model as Zod schemas — the single source of truth for
 * OFSCP types and runtime validation, mirroring `ofscp/schemas/v0.1`.
 *
 * Every object schema is `.passthrough()` (zod v3) so unknown JSON fields are
 * accepted AND preserved (§2.3 forward-compatibility); the WS envelope accepts
 * any `type` string. Each export pairs a `*Schema` (Zod) with its inferred
 * `type` (`z.infer`).
 *
 * Organized to mirror `defs/`: common, identity, groups, messaging, privacy,
 * objects (misc), and ws.
 */
export * from "./common.ts";
export * from "./identity.ts";
export * from "./groups.ts";
export * from "./messaging.ts";
export * from "./notifications.ts";
export * from "./privacy.ts";
export * from "./objects.ts";
export * from "./read-markers.ts";
export * from "./ws.ts";
