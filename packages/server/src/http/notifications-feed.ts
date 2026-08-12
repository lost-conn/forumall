/**
 * Inbound notifications-feed router (a provider-LOCAL extension — distinct from
 * the §10 outbound notification *webhooks* at `/api/notifications`). Three signed
 * endpoints, mounted at `/api/me`:
 *
 *  - `GET  /api/me/notifications?type=&limit=&cursor=` — the caller's newest-first
 *    feed (mentions + thread-replies), with per-type unseen `counts` for badges.
 *  - `POST /api/me/notifications/seen` — body `{ ids?: string[] }`; mark seen
 *    (omitted/empty = mark all unseen). Returns `{ affected, counts }`.
 *  - `POST /api/me/notifications/read` — body `{ ids?: string[] }`; mark read
 *    (read implies seen). Returns `{ affected, counts }`.
 *
 * State is private + per-account; marks are idempotent and scoped to the caller
 * (a caller can only touch their own rows). `notification.created` (live inbox)
 * is fanned from the message-create path, not here.
 */
import {
  NotificationsMarkRequestSchema,
  NotificationsMarkResponseSchema,
  NotificationsResponseSchema,
} from "@forumall/shared";
import { Hono } from "hono";

import { getUserRow } from "../provider/guests.ts";
import {
  listNotifications,
  markRead,
  markSeen,
  unreadCounts,
} from "../provider/notifications-feed.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * The caller-facing notifications router. Mounted at `/api/me`, so it serves
 * `/api/me/notifications`.
 */
export function createMeNotificationsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  // The inbox is the caller's own provider-local feed.
  const local = requireLocalActor();

  // -- GET /api/me/notifications (signed) ---------------------------------
  router.get("/notifications", signed, local, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const typeRaw = c.req.query("type");
    const type =
      typeRaw === "mention" || typeRaw === "reply" || typeRaw === "message" ? typeRaw : undefined;
    const cursor = c.req.query("cursor") ?? null;
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

    const handle = requireLocalHandle(c);
    const page = listNotifications(db, handle, {
      ...(type ? { type } : {}),
      cursor,
      ...(limit !== undefined ? { limit } : {}),
    });
    const counts = unreadCounts(db, handle);

    return c.json(
      NotificationsResponseSchema.parse({
        items: page.items,
        counts,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }),
      200,
    );
  });

  // -- POST /api/me/notifications/seen (signed) ---------------------------
  router.post("/notifications/seen", signed, local, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const handle = requireLocalHandle(c);
    if (!getUserRow(db, handle)) throw AppError.notFound({ detail: "no such user" });

    const ids = await parseMarkIds(c);
    const affected = markSeen(db, handle, ids);
    const counts = unreadCounts(db, handle);
    return c.json(NotificationsMarkResponseSchema.parse({ affected, counts }), 200);
  });

  // -- POST /api/me/notifications/read (signed) ---------------------------
  router.post("/notifications/read", signed, local, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const handle = requireLocalHandle(c);
    if (!getUserRow(db, handle)) throw AppError.notFound({ detail: "no such user" });

    const ids = await parseMarkIds(c);
    const affected = markRead(db, handle, ids);
    const counts = unreadCounts(db, handle);
    return c.json(NotificationsMarkResponseSchema.parse({ affected, counts }), 200);
  });

  return router;
}

/**
 * Parse the optional `{ ids?: string[] }` mark body. An empty/absent body marks
 * ALL of the caller's matching rows (→ `undefined` ids); a malformed body 400s.
 */
async function parseMarkIds(c: {
  req: { text(): Promise<string> };
}): Promise<string[] | undefined> {
  const text = await c.req.text();
  if (text.trim().length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw AppError.badRequest({ detail: "request body must be valid JSON" });
  }
  const parsed = NotificationsMarkRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.badRequest({
      detail: "invalid notifications mark request",
      extensions: { errors: parsed.error.flatten() },
    });
  }
  const ids = parsed.data.ids;
  return ids && ids.length > 0 ? ids : undefined;
}
