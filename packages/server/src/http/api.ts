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
import { createFederationContactsRouter, createMeContactsRouter } from "./contacts.ts";
import { createDiscoverRouter, createProvidersRouter } from "./discovery-feed.ts";
import { createDmsRouter, createFederationDmsRouter, createMeDmsRouter } from "./dms.ts";
import { createMeFollowsRouter } from "./follows.ts";
import { createGroupsRouter } from "./groups.ts";
import { createInvitesRouter } from "./invites.ts";
import { createMediaRouter } from "./media.ts";
import { createMeNotificationsRouter } from "./notifications-feed.ts";
import { createNotificationsRouter } from "./notifications.ts";
import { createPushRouter } from "./push.ts";
import { createMeReadMarkersRouter } from "./read-markers.ts";
import type { AppBindings } from "./types.ts";
import { createMeUserRouter, createUsersRouter } from "./users.ts";

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

  /** Media upload + serve (§5.8): single-step `multipart/form-data` upload. */
  api.route("/media", createMediaRouter());

  /** DM federation ingest (§7.4, §8.3): the single user-signed send path. */
  api.route("/federation/dms", createFederationDmsRouter());

  /** Contacts federation receiver (§6.7): cross-provider request/accept/remove. */
  api.route("/federation/contacts", createFederationContactsRouter());

  /** Caller's DM conversation list (§7.4): `GET /api/me/dms`. */
  api.route("/me", createMeDmsRouter());

  /** Contacts request/accept/remove/list (§6.7): `/api/me/contacts`. */
  api.route("/me", createMeContactsRouter());

  /** Follow list (pointers only, §7.6): `/api/me/follows`. No feed is stored. */
  api.route("/me/follows", createMeFollowsRouter());

  /** Read/unread tracking (provider-local): `/api/me/read-markers`. */
  api.route("/me", createMeReadMarkersRouter());

  /** Inbound notifications feed (provider-local): `/api/me/notifications`. */
  api.route("/me", createMeNotificationsRouter());

  /** Caller's account + profile + privacy (§5.1, §6.3, §6.6): `/api/me`. */
  api.route("/me", createMeUserRouter());

  /** Viewer-facing profile + membership listing (§6.2, §6.5): `/api/users`. */
  api.route("/users", createUsersRouter());

  /** DM history reads + edit/delete on the stored copy (§7.4, §7.1). */
  api.route("/dms", createDmsRouter());

  /** Notification webhook registration + delivery (§10): `/api/notifications`. */
  api.route("/notifications", createNotificationsRouter());

  /**
   * Web Push (provider-local): `/api/push`. The VAPID public key + browser
   * PushSubscription registration. Real OS/browser push for @mentions, replies,
   * and DMs is fired (fire-and-forget) from the message/DM paths when the
   * recipient has no live WS connection.
   */
  api.route("/push", createPushRouter());

  /**
   * Known providers (§8.6, OPTIONAL): `GET /api/providers`. 404 unless
   * `ENABLE_KNOWN_PROVIDERS` — gated inside the router so the discovery doc's
   * `sharesKnownProviders` flag and the endpoint stay in lockstep.
   */
  api.route("/providers", createProvidersRouter());

  /**
   * Discovery feed (§11.2, OPTIONAL): `GET /api/discover`. 404 unless
   * `ENABLE_DISCOVER_FEED`. Items are pointers to local `discoverable` channels,
   * compiled at read time — no feed is stored.
   */
  api.route("/discover", createDiscoverRouter());

  // Later: api.route("/channels", …); …

  return api;
}
