/**
 * Direct-message routers (spec §7.4, §8.3).
 *
 * Three signed endpoints, mounted on the `/api` router:
 *  - `POST /api/federation/dms/{dmId}/messages` — the single DM send path
 *    (user-signed). The signer is the author; the recipient's home provider
 *    (this provider, in the all-local case) stores the message in the LOCAL
 *    recipient's inbox and emits `dm.message`. NO sender copy is kept (§8.3).
 *  - `GET /api/me/dms` — paged list of the caller's DM conversations (§7.4).
 *  - `GET /api/dms/{dmId}/messages` — paged history from the caller's OWN inbox
 *    for the conversation, participant-only (§7.4).
 *
 * Plus edit/delete on the recipient's stored copy (author/tombstone, §7.1):
 *  - `PATCH /api/dms/{dmId}/messages/{messageId}` (author-only, edit window).
 *  - `DELETE /api/dms/{dmId}/messages/{messageId}` (tombstone).
 *
 * ## Recipient resolution (§8.3 `{dmId}` verification)
 * The recipient (inbox owner) is the LOCAL user `u` such that
 * `deriveDmId(author, "u@<domain>") === {dmId}`. We iterate the local `users`
 * table to find the match (O(n) — fine for a self-host v0.1; an index keyed by a
 * precomputed per-user dmId set could replace this if user counts grow). If NO
 * local user matches, the delivery is rejected with **400** — this enforces the
 * §8.3 rule that `{dmId}` MUST equal the id derived from `{author, recipient}`,
 * blocking inbox poisoning into a conversation the author is not part of.
 */
import {
  type Content,
  DmConversationSchema,
  DmConversationsResponseSchema,
  DmMessageCreateRequestSchema,
  type Message,
  MessageSchema,
  MessageUpdateRequestSchema,
  MessagesPageSchema,
  WsDmMessageSchema,
  canonicalAuthority,
  deriveDmId,
  rfc3339Timestamp,
} from "@forumall/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";

import { users } from "../db/schema.ts";
import {
  getDmConversationRow,
  getDmMessageByClientId,
  getDmMessageRow,
  isDmParticipant,
  listDmConversations,
  listDmMessages,
  storeDmMessage,
  tombstoneDmMessage,
  updateDmMessageContent,
} from "../provider/dms.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/** Parse `cursor` / `direction` / `limit` query params for a paged read. */
function pageQuery(c: Context<AppBindings>): {
  cursor: string | null;
  direction: "backward" | "forward";
  limit?: number;
} {
  const cursor = c.req.query("cursor") ?? null;
  const direction = c.req.query("direction") === "forward" ? "forward" : "backward";
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return { cursor, direction, ...(limit !== undefined ? { limit } : {}) };
}

/**
 * Build the `data` payload of a `dm.message` event for a stored record (§7.4),
 * validated against `WsDmMessageSchema`. Carries the `dmId`, the message's
 * opaque `cursor`, and the message body (with `clientMessageId` echoed when the
 * delivery carried one, so the recipient can de-dupe an optimistic echo).
 */
function dmMessageEventData(
  dmId: string,
  cursor: string,
  message: Message,
  clientMessageId?: string,
): unknown {
  return WsDmMessageSchema.shape.data.parse({
    dmId,
    cursor,
    message: {
      id: message.id,
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      author: message.author,
      createdAt: message.createdAt,
      content: message.content,
    },
  });
}

/**
 * The federation DM ingest router: `POST /api/federation/dms/{dmId}/messages`.
 * Mounted at `/api/federation/dms`.
 */
export function createFederationDmsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- POST /{dmId}/messages (§7.4, §8.3 — signed) ------------------------
  router.post("/:dmId/messages", signed, async (c) => {
    const { config, db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const author = actor.actor;

    const body = DmMessageCreateRequestSchema.parse(await c.req.json());

    // --- Recipient resolution + §8.3 {dmId} verification -------------------
    // The recipient is the LOCAL user `u` whose derived dmId with the author
    // equals {dmId}. O(n) over local users (acceptable for self-host v0.1; a
    // precomputed index could replace this). No match → 400 (inbox poisoning).
    const authority = canonicalAuthority(config.domain);
    const localUsers = db.drizzle.select({ handle: users.handle }).from(users).all();
    let owner: string | null = null;
    for (const u of localUsers) {
      const recipientActor = `${u.handle}@${authority}`;
      if (deriveDmId(author, recipientActor) === dmId) {
        owner = u.handle;
        break;
      }
    }
    if (owner === null) {
      throw AppError.badRequest({
        detail: "{dmId} does not match a conversation between the author and a local recipient",
      });
    }
    const recipientActor = `${owner}@${authority}`;

    // --- Idempotency: a duplicate delivery returns the existing message ----
    const existing = getDmMessageByClientId(db, owner, dmId, author, body.clientMessageId);
    if (existing) {
      return c.json(MessageSchema.parse(existing.message), 200);
    }

    // --- Store in the recipient's inbox (only here — no sender copy) -------
    const record = storeDmMessage(db, config, {
      owner,
      dmId,
      author,
      content: body.content,
      ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      ...(body.reference !== undefined ? { reference: body.reference } : {}),
      clientMessageId: body.clientMessageId,
    });

    // --- Real-time: deliver `dm.message` to the recipient ONLY -------------
    // Use publishToActor so every connection of the recipient receives it; only
    // the recipient's inbox stored it, so only the recipient is notified (§7.4).
    hub.publishToActor(recipientActor, {
      type: "dm.message",
      data: dmMessageEventData(dmId, record.cursor, record.message, body.clientMessageId),
    });

    // Respond with the stored canonical message (the local sender's confirmation;
    // the sender still keeps its own optimistic copy client-side, §7.4).
    return c.json(MessageSchema.parse(record.message), 201);
  });

  return router;
}

/** The `GET /api/me/dms` router. Mounted at `/api/me`. */
export function createMeDmsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /dms (§7.4 — signed) -------------------------------------------
  router.get("/dms", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const { cursor, limit } = pageQuery(c);
    const page = listDmConversations(db, actor.handle, {
      cursor,
      ...(limit !== undefined ? { limit } : {}),
    });

    const response = {
      items: page.items.map((conv) =>
        DmConversationSchema.parse({
          id: conv.dmId,
          participants: [actor.actor, conv.counterparty],
          ...(conv.lastMessage ? { lastMessage: conv.lastMessage } : {}),
          updatedAt: rfc3339Timestamp(new Date(conv.updatedAt)),
          metadata: [],
        }),
      ),
      page: page.page,
    };
    return c.json(DmConversationsResponseSchema.parse(response));
  });

  return router;
}

/**
 * The `/api/dms/{dmId}/messages` router (read + edit/delete). Mounted at
 * `/api/dms`.
 */
export function createDmsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /{dmId}/messages (§7.4 — signed, participant-only) -------------
  router.get("/:dmId/messages", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const owner = actor.handle;

    // Participation: no conversation row for the caller → unknown to this inbox.
    // Practical rule (per card): a 404 for an unknown dmId, since a non-
    // participant simply has no inbox conversation row for it.
    if (!isDmParticipant(db, owner, dmId)) {
      throw AppError.notFound({ detail: "no such conversation" });
    }

    const { cursor, direction, limit } = pageQuery(c);
    const page = listDmMessages(db, owner, dmId, {
      cursor,
      direction,
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(MessagesPageSchema.parse(page));
  });

  // -- PATCH /{dmId}/messages/{messageId} (§7.1 edit on stored copy) ------
  // Author-only + edit window, applied to the recipient's stored copy.
  router.patch("/:dmId/messages/:messageId", signed, async (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const owner = actor.handle;

    const body = MessageUpdateRequestSchema.parse(await c.req.json());

    const row = getDmMessageRow(db, owner, dmId, messageId);
    if (!row) throw AppError.notFound({ detail: "no such message" });
    if (row.author !== actor.actor) {
      throw AppError.forbidden({ detail: "only the author may edit this message" });
    }
    if (Date.now() > row.editUntil) {
      throw AppError.forbidden({ detail: "the edit window for this message has passed" });
    }

    const record = updateDmMessageContent(db, owner, dmId, messageId, body.content as Content);
    hub.publishToActor(actor.actor, {
      type: "dm.message",
      data: dmMessageEventData(dmId, record.cursor, record.message),
    });
    return c.json(MessageSchema.parse(record.message));
  });

  // -- DELETE /{dmId}/messages/{messageId} (§7.1 tombstone) --------------
  // The owner of the inbox copy may delete it (tombstone). The author/tombstone
  // rules of §7.1 apply against the recipient's stored copy.
  router.delete("/:dmId/messages/:messageId", signed, (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const owner = actor.handle;

    // Only a participant has an inbox; require the conversation row too.
    if (!getDmConversationRow(db, owner, dmId)) {
      throw AppError.notFound({ detail: "no such conversation" });
    }
    const row = getDmMessageRow(db, owner, dmId, messageId);
    if (!row) throw AppError.notFound({ detail: "no such message" });

    const record = tombstoneDmMessage(db, owner, dmId, messageId);
    hub.publishToActor(actor.actor, {
      type: "dm.message",
      data: dmMessageEventData(dmId, record.cursor, record.message),
    });
    return c.body(null, 204);
  });

  return router;
}
