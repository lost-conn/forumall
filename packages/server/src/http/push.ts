/**
 * Web Push registration router (provider-local extension). Mounted at
 * `/api/push`.
 *
 * Endpoints:
 *  - `GET  /public-key`  — the provider's VAPID application-server public key,
 *    which the browser passes as `applicationServerKey` when subscribing. No
 *    auth required (it is public material; signed when present, anonymous fine).
 *  - `POST /subscribe`   — register the authenticated user's browser
 *    `PushSubscription` ({endpoint, keys:{p256dh, auth}}). 201 with `{id}`.
 *  - `POST /unsubscribe` — remove a subscription (by `endpoint`). 204.
 *
 * Subscriptions bind to the authenticated LOCAL `owner` (handle); a client can
 * never register on behalf of another user. Delivery is fired from the message /
 * DM paths (see `provider/push-send.ts`), not from this router.
 */
import { PushSubscribeRequestSchema, PushUnsubscribeRequestSchema } from "@forumall/shared";
import { Hono } from "hono";

import { egressCheck } from "../provider/push-egress-check.ts";
import { addSubscription, getVapidKey, removeSubscription } from "../provider/push.ts";
import { AppError } from "./errors.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** The push router: VAPID public key + subscribe / unsubscribe. */
export function createPushRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /public-key (public) -------------------------------------------
  // The VAPID application-server public key. Generated + persisted on first use.
  router.get("/public-key", optionalSignature(), (c) => {
    const { db } = c.var;
    const key = getVapidKey(db);
    return c.json({ publicKey: key.publicKey }, 200);
  });

  // -- GET /_egress-check (public, ops diagnostic) ------------------------
  // Reports whether THIS host can reach the browser push services and over which
  // IP family (raw TCP per family + the real fetch path). Hosts are hard-coded,
  // so there is no SSRF surface. Use it to tell "IPv6 black-hole" (force IPv4)
  // from "egress blocked entirely" (needs a proxy) on a constrained deploy.
  router.get("/_egress-check", async (c) => {
    const { config } = c.var;
    const report = await egressCheck(
      config.dnsResultOrder,
      config.dnsServers,
      config.pushProxy !== undefined,
    );
    return c.json(report, 200);
  });

  // -- POST /subscribe (signed) -------------------------------------------
  // Register the caller's browser PushSubscription → 201 with the row id.
  router.post("/subscribe", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = PushSubscribeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid push subscription",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const id = addSubscription(db, actor.handle, {
      endpoint: parsed.data.endpoint,
      keys: { p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth },
    });
    return c.json({ id }, 201);
  });

  // -- POST /unsubscribe (signed) -----------------------------------------
  // Remove the caller's subscription by endpoint. 204 whether or not it existed.
  router.post("/unsubscribe", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = PushUnsubscribeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({ detail: "invalid unsubscribe request" });
    }

    removeSubscription(db, actor.handle, parsed.data.endpoint);
    return c.body(null, 204);
  });

  return router;
}
