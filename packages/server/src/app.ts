import { Hono } from "hono";
/**
 * App factory: assembles the Hono application from config + injected deps.
 *
 * Responsibilities:
 *  - inject `config`, `db`, and the real-time {@link Hub} into the request
 *    context (`c.var`) for handlers;
 *  - mount the `/api` router and the `GET /api/ws` WebSocket endpoint (§7.1);
 *  - install the problem+json `onError` and `notFound` handlers;
 *  - serve the built web client as static for all non-API routes, with SPA
 *    fallback to `index.html`. The static dir is `config.webDir` (configurable,
 *    so tests can point it at a temp dir); a missing dir does not crash the app
 *    — API works and static routes 404 cleanly.
 *
 * `createApp` is pure (no I/O, no port binding), so it can be driven directly
 * in tests via `app.request(...)`.
 *
 * ## WebSocket wiring (§7.1)
 * Bun's WS support needs two pieces: the upgrade handler (mounted on the route)
 * and a `websocket` handler object that the Bun entry must export alongside
 * `fetch`. {@link createBunWebSocket} returns both; {@link createApp} mounts the
 * upgrade route and exposes the `websocket` object as `app.__websocket` so the
 * Bun entry (`index.ts`) and the test harness can pass it to `Bun.serve`. The
 * {@link Hub} is created once here (or injected) and shared via `c.var.hub`, so
 * later real-time cards publish through the same connection registry.
 */
import { createBunWebSocket } from "hono/bun";

import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import { createApiRouter } from "./http/api.ts";
import { createDiscoveryRouter } from "./http/discovery.ts";
import { notFound, onError } from "./http/errors.ts";
import { createStaticHandler } from "./http/static.ts";
import type { AppBindings } from "./http/types.ts";
import { createUserKeysRouter } from "./http/user-keys.ts";
import { type WsTimings, createWsHandlers } from "./http/ws.ts";
import { RemoteDiscoveryCache } from "./provider/federation/discovery-cache.ts";
import { type FederationFetch, defaultFederationFetch } from "./provider/federation/http.ts";
import { RemoteUserKeysCache } from "./provider/federation/user-keys-cache.ts";
import { PresenceRegistry } from "./provider/presence.ts";
import { Hub } from "./provider/ws-hub.ts";

export interface AppDeps {
  readonly db: Db;
  /** Shared real-time hub; one is created if not injected. */
  readonly hub?: Hub;
  /** Shared presence-subscription registry (§7.5); one is created if not injected. */
  readonly presenceRegistry?: PresenceRegistry;
  /** Heartbeat / handshake timings (§7.1); tests pass short values. */
  readonly wsTimings?: Partial<WsTimings>;
  /**
   * Injectable outbound federation fetch (§8). Defaults to the global-`fetch`
   * transport (`https://{domain}/...`). The two-provider test harness injects a
   * fetcher mapping `*.test` domains to localhost ports while preserving the
   * authority, so peer signature verification still binds the real domain.
   */
  readonly federationFetch?: FederationFetch;
  /** Shared remote-discovery cache (§8.1); one is created if not injected. */
  readonly discoveryCache?: RemoteDiscoveryCache;
  /** Shared remote user-keys cache (§4.6); one is created if not injected. */
  readonly userKeysCache?: RemoteUserKeysCache;
}

/** A Hono app augmented with the Bun `websocket` handler object it requires. */
export type AppWithWebSocket = Hono<AppBindings> & {
  /** The Bun WS handler object to export alongside `fetch` (see file header). */
  readonly __websocket: ReturnType<typeof createBunWebSocket>["websocket"];
  /** The shared real-time hub (for tests / later wiring). */
  readonly __hub: Hub;
  /** The shared presence-subscription registry (for tests / later wiring). */
  readonly __presenceRegistry: PresenceRegistry;
  /** The shared remote-discovery cache (for tests / later wiring). */
  readonly __discoveryCache: RemoteDiscoveryCache;
  /** The shared remote user-keys cache (for tests / later wiring). */
  readonly __userKeysCache: RemoteUserKeysCache;
};

export function createApp(config: Config, deps: AppDeps): AppWithWebSocket {
  const app = new Hono<AppBindings>();
  const hub = deps.hub ?? new Hub();
  const presenceRegistry = deps.presenceRegistry ?? new PresenceRegistry();
  const federationFetch = deps.federationFetch ?? defaultFederationFetch;
  // The discovery cache shares the injected federation fetch so it reaches the
  // same (real or in-process-peer) transport the rest of federation uses.
  const discoveryCache = deps.discoveryCache ?? new RemoteDiscoveryCache({ federationFetch });
  // The user-keys cache likewise shares the injected federation fetch so remote
  // actor key resolution (§4.6) reaches the same transport (real TLS or peer).
  const userKeysCache = deps.userKeysCache ?? new RemoteUserKeysCache({ federationFetch });

  const { upgradeWebSocket, websocket } = createBunWebSocket();

  // Make config + db + hub + presence registry + federation deps available to
  // every handler.
  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("db", deps.db);
    c.set("hub", hub);
    c.set("presenceRegistry", presenceRegistry);
    c.set("federationFetch", federationFetch);
    c.set("discoveryCache", discoveryCache);
    c.set("userKeysCache", userKeysCache);
    await next();
  });

  // Root-level OFSCP discovery (§3.1). Mounted before the SPA static handler so
  // `/.well-known/ofscp-provider` is never shadowed by the index.html fallback.
  app.route("/", createDiscoveryRouter());

  // Root-level public key discovery (§4.6): `/.well-known/ofscp/users/{handle}/keys`.
  // Also mounted before the static handler so it isn't shadowed by the SPA.
  app.route("/", createUserKeysRouter());

  // Real-time WebSocket endpoint (§7.1): the signed-challenge handshake,
  // subscribe/unsubscribe, and heartbeat. Mounted before the SPA static handler
  // (it lives under `/api/`, so it falls through the static guard anyway, but we
  // register it explicitly here). The same handler instance is shared across all
  // connections; per-connection state lives in the closure (`createWsHandlers`).
  const wsHandlers = createWsHandlers({
    config,
    db: deps.db,
    hub,
    presenceRegistry,
    // §8.5 step 3: the WS handshake resolves a REMOTE actor's `authenticate` key
    // via this same user-keys cache the HTTP signature path uses.
    userKeysCache,
    ...(deps.wsTimings !== undefined ? { timings: deps.wsTimings } : {}),
  });
  app.get(
    "/api/ws",
    upgradeWebSocket(() => wsHandlers),
  );

  // API surface. Unmatched `/api/*` paths fall through to `notFound` below.
  app.route("/api", createApiRouter());

  // Static web client (SPA) for everything that isn't an API route. Registered
  // after `/api` so it never shadows the API. A `null` result (no web build)
  // falls through to the notFound handler.
  const serveStatic = createStaticHandler(config.webDir);
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api/") || c.req.path === "/api") {
      return next();
    }
    const res = await serveStatic(c.req.path);
    if (res) return res;
    return next();
  });

  app.notFound(notFound);
  app.onError(onError);

  // Attach the Bun WS handler object + hub + registry for the entry/test harness.
  return Object.assign(app, {
    __websocket: websocket,
    __hub: hub,
    __presenceRegistry: presenceRegistry,
    __discoveryCache: discoveryCache,
    __userKeysCache: userKeysCache,
  });
}
