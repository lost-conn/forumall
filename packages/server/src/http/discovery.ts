/**
 * Root-level provider discovery router (spec §3.1).
 *
 * Serves `GET /.well-known/ofscp-provider`. This lives at the *root* (not under
 * `/api`) and MUST be mounted before the SPA static handler so it isn't
 * shadowed. The body validates against `ProviderDiscoverySchema`.
 *
 * Caching: a weak `ETag` + a short `Cache-Control` are set (§3.1 SHOULD), and
 * `If-None-Match` is honored with a `304`.
 */
import { Hono } from "hono";

import { buildDiscoveryDocument, discoveryETag } from "../provider/discovery.ts";
import type { AppBindings } from "./types.ts";

/** Clients may cache discovery; re-validate after this window. */
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

export function createDiscoveryRouter() {
  const router = new Hono<AppBindings>();

  router.get("/.well-known/ofscp-provider", (c) => {
    const { config, db } = c.var;
    const doc = buildDiscoveryDocument(config, db);
    const etag = discoveryETag(doc);

    c.header("Cache-Control", CACHE_CONTROL);
    c.header("ETag", etag);

    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    return c.json(doc);
  });

  return router;
}
