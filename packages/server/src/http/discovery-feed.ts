/**
 * Known-providers + discovery-feed routers (spec §8.6, §11.2 — both OPTIONAL).
 *
 * Both endpoints are gated by a config toggle (default OFF). When the toggle is
 * off the endpoint returns **404** — the same "not offered" signal the discovery
 * document carries (`capabilities.discovery.sharesKnownProviders` /
 * `discoverFeed`, §3.1), which is derived from the same flags. Neither endpoint
 * requires authentication: §8.6 / §11.2 are public reads.
 *
 *  - `GET /api/providers` (§8.6): when `config.enableKnownProviders`, returns the
 *    known-providers list `{ providers, metadata }` (schema-valid). v0.1
 *    collapses "maintains" and "shares" into the one flag — enabled = maintains
 *    AND shares. The spec's optional 403 "maintains but declines to share" path
 *    is not implemented (it would need a second flag); off → 404.
 *  - `GET /api/discover` (§11.2): when `config.enableDiscoverFeed`, returns a
 *    paged feed of POINTERS to local `discoverable`-tier channels (schema-valid).
 *    Nothing is stored — items are compiled at read time (`provider/discover.ts`).
 */
import { ProvidersResponseSchema } from "@forumall/shared";
import { Hono } from "hono";

import { compileDiscoverPage } from "../provider/discover.ts";
import { listKnownProviders } from "../provider/known-providers.ts";
import { AppError } from "./errors.ts";
import type { AppBindings } from "./types.ts";

/** `GET /api/providers` — the known-providers list (§8.6). */
export function createProvidersRouter() {
  const router = new Hono<AppBindings>();

  router.get("/", (c) => {
    const { config, db } = c.var;
    // Off → the provider maintains no shareable list: 404 (§8.6). Matches the
    // discovery doc's `sharesKnownProviders: false`.
    if (!config.enableKnownProviders) {
      throw AppError.notFound({ detail: "this provider does not share a known-providers list" });
    }

    const providers = listKnownProviders(db);
    return c.json(ProvidersResponseSchema.parse({ providers, metadata: [] }), 200);
  });

  return router;
}

/** `GET /api/discover` — the discovery feed of channel pointers (§11.2). */
export function createDiscoverRouter() {
  const router = new Hono<AppBindings>();

  router.get("/", (c) => {
    const { config, db } = c.var;
    // Off → no discovery feed offered: 404 (§11.2). Matches the discovery doc's
    // `discoverFeed: false`.
    if (!config.enableDiscoverFeed) {
      throw AppError.notFound({ detail: "this provider does not offer a discovery feed" });
    }

    const cursor = c.req.query("cursor") ?? null;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw != null ? Number(limitRaw) : undefined;

    const page = compileDiscoverPage(db, config, {
      cursor,
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    return c.json(page, 200);
  });

  return router;
}
