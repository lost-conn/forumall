/**
 * The `/api` router root.
 *
 * P2 ships only a liveness/identity endpoint; later cards mount their
 * sub-routers here (auth, groups, channels, messaging, …). Add a feature by
 * creating its router module and `api.route("/<segment>", featureRouter)` below.
 *
 * Note: the 404 / onError handlers are installed on the *parent* app, so any
 * unmatched `/api/*` path produces a problem+json 404.
 */
import { OFSCP_VERSION } from "@forumall/shared";
import { Hono } from "hono";

import { TIERS } from "../provider/tiers.ts";
import { createAuthRouter } from "./auth.ts";
import { createGroupsRouter } from "./groups.ts";
import { createInvitesRouter } from "./invites.ts";
import type { AppBindings } from "./types.ts";

export function createApiRouter() {
  const api = new Hono<AppBindings>();

  /** Liveness + provider identity probe. */
  api.get("/health", (c) => {
    const { config } = c.var;
    return c.json({
      status: "ok",
      ofscp: OFSCP_VERSION,
      domain: config.domain,
    });
  });

  /** Tier discovery (§11.1): canonical access/discoverability levels. */
  api.get("/tiers", (c) => c.json(TIERS));

  /** Local auth: register + login → bootstrap tokens (§4.1, §4.2). */
  api.route("/auth", createAuthRouter());

  /** Group CRUD + permission model (§5.2, §5.5). */
  api.route("/groups", createGroupsRouter());

  /** Invite redemption + guest provisioning (§5.6, §4.8). */
  api.route("/invites", createInvitesRouter());

  // Later: api.route("/channels", …); …

  return api;
}
