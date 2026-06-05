/**
 * App factory: assembles the Hono application from config + injected deps.
 *
 * Responsibilities:
 *  - inject `config` and `db` into the request context (`c.var`) for handlers;
 *  - mount the `/api` router;
 *  - install the problem+json `onError` and `notFound` handlers;
 *  - serve the built web client as static for all non-API routes, with SPA
 *    fallback to `index.html`. The static dir is `config.webDir` (configurable,
 *    so tests can point it at a temp dir); a missing dir does not crash the app
 *    — API works and static routes 404 cleanly.
 *
 * `createApp` is pure (no I/O, no port binding), so it can be driven directly
 * in tests via `app.request(...)`.
 */
import { Hono } from "hono";

import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import { createApiRouter } from "./http/api.ts";
import { createDiscoveryRouter } from "./http/discovery.ts";
import { notFound, onError } from "./http/errors.ts";
import { createStaticHandler } from "./http/static.ts";
import type { AppBindings } from "./http/types.ts";
import { createUserKeysRouter } from "./http/user-keys.ts";

export interface AppDeps {
  readonly db: Db;
}

export function createApp(config: Config, deps: AppDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Make config + db available to every handler via c.var.
  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("db", deps.db);
    await next();
  });

  // Root-level OFSCP discovery (§3.1). Mounted before the SPA static handler so
  // `/.well-known/ofscp-provider` is never shadowed by the index.html fallback.
  app.route("/", createDiscoveryRouter());

  // Root-level public key discovery (§4.6): `/.well-known/ofscp/users/{handle}/keys`.
  // Also mounted before the static handler so it isn't shadowed by the SPA.
  app.route("/", createUserKeysRouter());

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

  return app;
}
