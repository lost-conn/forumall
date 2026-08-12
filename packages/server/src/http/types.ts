/**
 * Shared Hono typing for the app and its routers.
 *
 * `Variables` are populated by middleware in {@link createApp} and read via
 * `c.var` in handlers. Feature cards extend `Variables` (e.g. an authenticated
 * `actor`) by adding to this interface.
 */
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { RemoteDiscoveryCache } from "../provider/federation/discovery-cache.ts";
import type { FederationFetch } from "../provider/federation/http.ts";
import type { RemoteUserKeysCache } from "../provider/federation/user-keys-cache.ts";
import type { PresenceRegistry } from "../provider/presence.ts";
import type { Hub } from "../provider/ws-hub.ts";

/**
 * Which identity a signed request authenticated as (§4.5): a user **device key**
 * (`X-OFSCP-Actor`, §4.4) or the **provider signing key** (`X-OFSCP-Provider`,
 * §8.1). Exposed on `c.var.signatureMode` alongside `c.var.actor` so a route that
 * accepts BOTH (see `requireActorOrProviderSignature`) can tell them apart.
 */
export type SignatureMode = "actor" | "provider";

/**
 * The authenticated identity established by the signed-request middleware
 * (`requireSignature`, §4.5). Present on `c.var.actor` only on routes guarded by
 * that middleware; unauthenticated routes leave it `undefined`.
 *
 * ## The identity rule: a handle is only meaningful WITH its domain
 * `requireSignature` authenticates **remote** actors too (§4.6): a signer whose
 * home provider is not this one has their key resolved from that provider's keys
 * endpoint and is just as authenticated as a local user. Their identity is
 * `{ actor: "alice@remote.example", domain: "remote.example" }` — and the BARE
 * handle `alice` in it belongs to *their* provider's namespace, NOT ours.
 *
 * Every provider-local table here (`users`, `presence`, `privacy_settings`,
 * `contacts`, `read_markers`, `follows`, `notification_*`, `push_subscriptions`,
 * `dm_conversations.owner`, `dm_messages.owner`, …) is keyed on a **local**
 * handle. Keying any of those on a remote signer's bare handle silently treats
 * them as the LOCAL user of the same name — an account takeover for anyone who
 * runs their own provider and registers a colliding handle.
 *
 * So this type deliberately does NOT carry a plain `handle`. It carries:
 *  - {@link actor} / {@link domain} — the full, always-safe identity. Use these
 *    for anything that compares or stores an actor (message authorship, DM
 *    participants, permissions, visibility, fan-out targets).
 *  - {@link localHandle} — present **iff** the signer is a user of THIS provider,
 *    and therefore the ONLY value that may be used as a local storage key. It is
 *    `undefined` for a remote actor and for a provider identity (§8.1), so the
 *    compiler forces every local-storage call site to decide what a remote caller
 *    means there. The two correct answers are: reject the remote caller
 *    (`requireLocalActor()` / `requireLocalHandle()` in `http/signature.ts` — the
 *    right answer for every `/api/me` route and the admin guard, since a remote
 *    actor has no account here at all), or handle them on a separate branch that
 *    resolves storage through the full `actor` (see the DM edit/delete/reaction
 *    routing tables in `http/dms.ts`, where an only-sent REMOTE author is a
 *    legitimate caller resolved via `resolveLocalDmOwner`).
 *
 * Never re-derive a bare handle by splitting {@link actor} to get around this.
 */
export interface AuthenticatedActor {
  /** Full actor/provider identifier as sent, e.g. `alice@providera.com`. */
  readonly actor: string;
  /**
   * The signer's handle **in this provider's namespace** — set only when the
   * identity is a user actor whose domain is this provider's `config.domain`.
   * `undefined` for a REMOTE actor (§4.6) and for a provider identity (§8.1).
   * The only value safe to use as a key into provider-local storage; see the
   * interface doc above.
   */
  readonly localHandle?: string;
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
  /**
   * Injectable outbound federation fetch (§8). Routes a logical provider domain
   * to its transport; the default hits `https://{domain}/...` via global `fetch`,
   * the test harness maps `*.test` → localhost ports. Used by
   * `signedProviderFetch` and the discovery cache to reach remote providers.
   */
  readonly federationFetch: FederationFetch;
  /**
   * Remote provider discovery cache (§8.1): fetches + caches peers'
   * `provider.publicKeys` so the signature middleware can verify provider-signed
   * requests from remote providers (with a forced re-fetch on a verify miss).
   */
  readonly discoveryCache: RemoteDiscoveryCache;
  /**
   * Remote actor user-keys cache (§4.6): fetches + caches a remote user's active
   * device keys so the signature middleware can verify user-signed requests from
   * actors whose home provider is not this one (with a forced re-fetch on a
   * verify miss for key rotation/revocation).
   */
  readonly userKeysCache: RemoteUserKeysCache;
  /** Set by `requireSignature` on success; undefined on unauthenticated routes. */
  actor?: AuthenticatedActor;
  /**
   * The identity mode that verified the request, set alongside `actor`. Only
   * interesting on routes that accept EITHER identity (§4.4 user-signed *or*
   * §8.1 provider-signed) — they read it to decide whose authority the acting
   * actor is drawn from. Undefined on unauthenticated routes.
   */
  signatureMode?: SignatureMode;
}

export interface AppBindings {
  Variables: AppVariables;
}
