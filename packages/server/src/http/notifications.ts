/**
 * Notification webhook registration router (spec §10). Mounted at
 * `/api/notifications`.
 *
 * Endpoints (all signed, §4.5):
 *  - `POST   /endpoints`        — register a webhook for the authenticated user.
 *  - `GET    /endpoints`        — list the caller's own endpoints.
 *  - `DELETE /endpoints/{id}`   — delete one of the caller's endpoints.
 *
 * Registration binds the endpoint to the authenticated LOCAL `owner` (handle);
 * clients can never register on behalf of another user. Delivery of the
 * registered events is provider-signed (§8.1) and carries a detached body
 * `signature` (see `provider/notifications.ts`); it is fired from the event flow
 * (the WS `message.create` fan-out), not from this router.
 */
import { NotificationsWebhookRegistrationSchema } from "@forumall/shared";
import { type Context, Hono } from "hono";

import { deleteEndpoint, listEndpoints, registerEndpoint } from "../provider/notifications.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/** The notifications router: register / list / delete webhook endpoints (§10). */
export function createNotificationsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- POST /endpoints (§10 — signed) -------------------------------------
  // Register a webhook for the authenticated user → 201 with the id-stamped echo.
  router.post("/endpoints", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = NotificationsWebhookRegistrationSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid notification webhook registration",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const endpoint = registerEndpoint(db, actor.handle, parsed.data);
    return c.json(endpoint, 201);
  });

  // -- GET /endpoints (§10 — signed) --------------------------------------
  // List the caller's own registered endpoints.
  router.get("/endpoints", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    return c.json({ endpoints: listEndpoints(db, actor.handle) }, 200);
  });

  // -- DELETE /endpoints/{id} (§10 — signed) ------------------------------
  // Delete one of the caller's endpoints. Idempotent-ish: 204 on success, 404 if
  // there is no such endpoint owned by the caller.
  router.delete("/endpoints/:id", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const id = requireParam(c, "id");
    if (!deleteEndpoint(db, actor.handle, id)) {
      throw AppError.notFound({ detail: "no such notification endpoint" });
    }
    return c.body(null, 204);
  });

  return router;
}
