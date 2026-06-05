/**
 * Shared Hono typing for the app and its routers.
 *
 * `Variables` are populated by middleware in {@link createApp} and read via
 * `c.var` in handlers. Feature cards extend `Variables` (e.g. an authenticated
 * `actor`) by adding to this interface.
 */
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { PresenceRegistry } from "../provider/presence.ts";
import type { Hub } from "../provider/ws-hub.ts";

/**
 * The authenticated identity established by the signed-request middleware
 * (`requireSignature`, §4.5). Present on `c.var.actor` only on routes guarded by
 * that middleware; unauthenticated routes leave it `undefined`.
 */
export interface AuthenticatedActor {
  /** Full actor/provider identifier as sent, e.g. `alice@providera.com`. */
  readonly actor: string;
  /** Local handle for a user actor; empty string for a provider identity (§8.1). */
  readonly handle: string;
  /** The `X-OFSCP-Key-ID` whose key verified the request. */
  readonly keyId: string;
  /** Canonicalized authority/domain the identity belongs to. */
  readonly domain: string;
}

export interface AppVariables {
  readonly config: Config;
  readonly db: Db;
  /**
   * The real-time WebSocket fan-out hub (§7.1). Shared across the app so later
   * cards (message create, reactions, typing, presence, DM, calls) can call
   * `c.var.hub.publishToChannel(...)` / `publishToActor(...)` from their HTTP or
   * WS handlers.
   */
  readonly hub: Hub;
  /**
   * Connection-scoped presence subscriptions (§7.5). Shared across the app so the
   * REST `PUT /api/me/presence` fan-out reaches the same subscriber connections
   * the WS `presence.set` would, keeping the two surfaces consistent.
   */
  readonly presenceRegistry: PresenceRegistry;
  /** Set by `requireSignature` on success; undefined on unauthenticated routes. */
  actor?: AuthenticatedActor;
}

export interface AppBindings {
  Variables: AppVariables;
}
