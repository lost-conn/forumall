/**
 * The caller's DM conversation list and conversation pointers (§7.4
 * "Conversation pointers", "Listing & reading"): `GET /api/me/dms` and
 * `PUT /api/me/dms/{dmId}`. Both are signed local-account endpoints.
 */
import {
  DmConversationPointerRequestSchema,
  DmConversationsResponseSchema,
  canonicalAuthority,
  deriveDmId,
} from "@forumall/shared";
import { Hono } from "hono";
import { listDmConversations, upsertDmPointer } from "../provider/dms.ts";
import { isProviderAllowed } from "../provider/federation/policy.ts";
import { assertCanonicalActorField } from "./canonical-fields.ts";
import { publishDmConversation, wireConversation } from "./dm-events.ts";
import { pageQuery, requireParam } from "./dm-request.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** The `GET /api/me/dms` + `PUT /api/me/dms/{dmId}` router. Mounted at `/api/me`. */
export function createMeDmsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  // The conversation list IS the caller's local inbox index (`dm_conversations.
  // owner`), which only a user of this provider has; a remote actor reads its
  // conversations at its own home provider (403 here).
  const local = requireLocalActor();

  // -- GET /dms (§7.4 — signed, local caller) ------------------------------
  router.get("/dms", signed, local, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const { cursor, limit } = pageQuery(c);
    const page = listDmConversations(db, requireLocalHandle(c), canonicalAuthority(config.domain), {
      cursor,
      ...(limit !== undefined ? { limit } : {}),
    });

    const response = {
      items: page.items.map((conv) => wireConversation(actor.actor, conv)),
      page: page.page,
    };
    return c.json(DmConversationsResponseSchema.parse(response));
  });

  // -- PUT /dms/{dmId} (§7.4 conversation pointer — signed, local caller) ---
  // Record that the caller has a conversation with `with` (typically right
  // after sending to `with`'s home provider), optionally caching the message
  // just sent as a non-authoritative preview. Lists started conversations and
  // syncs them to the caller's other devices via `dm.conversation`.
  router.put("/dms/:dmId", signed, local, async (c) => {
    const { config, db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = DmConversationPointerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid conversation pointer",
        extensions: { errors: parsed.error.flatten() },
      });
    }
    const { with: counterparty, lastMessage } = parsed.data;
    // `with` must be an actor in canonical form (`handle@domain`, lowercase,
    // canonical authority). A URI or non-canonical spelling would either throw
    // in deriveDmId or be stored as typed and break exact participant matching.
    assertCanonicalActorField(counterparty, "with");
    const withDomain = counterparty.slice(counterparty.lastIndexOf("@") + 1);
    if (counterparty === actor.actor || deriveDmId(actor.actor, counterparty) !== dmId) {
      throw AppError.badRequest({
        detail: "{dmId} does not match a conversation between the caller and `with`",
      });
    }
    // A pointer row makes this provider send provider-signed requests to the
    // counterparty's host (reaction/edit/delete forwards), so it must obey the
    // same federation policy as an inbound remote sender (§8).
    if (
      withDomain !== canonicalAuthority(config.domain) &&
      !isProviderAllowed(config, withDomain)
    ) {
      throw AppError.forbidden({ detail: "federation with that provider is not allowed" });
    }
    // The cached preview must be a message the CALLER sent in this conversation.
    if (lastMessage !== undefined && lastMessage.author !== actor.actor) {
      throw AppError.badRequest({ detail: "`lastMessage` must be authored by the caller" });
    }

    const handle = requireLocalHandle(c);
    upsertDmPointer(
      db,
      `${handle}@${canonicalAuthority(config.domain)}`,
      dmId,
      counterparty,
      lastMessage,
    );
    const item = publishDmConversation(hub, db, actor.actor, handle, dmId);
    return c.json(item, 200);
  });

  return router;
}
