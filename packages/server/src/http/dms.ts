/**
 * Direct-message routers (spec §7.4, §8.3).
 *
 * This module holds the `/api/me/dms` and `/api/dms` routers; the federation
 * ingest router is `dms-federation.ts`, with shared helpers in `dm-request.ts`,
 * `dm-events.ts` and `dm-forwarding.ts`.
 *
 * Three signed endpoints, mounted on the `/api` router:
 *  - `POST /api/federation/dms/{dmId}/messages` — the single DM send path
 *    (user-signed). The signer is the author; the recipient's home provider
 *    (this provider, in the all-local case) stores the message in the LOCAL
 *    recipient's inbox and emits `dm.message`. NO sender copy is kept (§8.3).
 *  - `GET /api/me/dms` — paged list of the caller's DM conversations (§7.4).
 *  - `GET /api/dms/{dmId}/messages` — paged history: the caller's FULL
 *    conversation view (what they received ∪ what they sent), participant-only
 *    (§7.4).
 *
 * Plus edit/delete/react on the stored copy, wherever it lives (§7.1) — all four
 * share one storage-follows-message routing, see the decision tables on the
 * routes themselves:
 *  - `PATCH /api/dms/{dmId}/messages/{messageId}` (author-only, edit window).
 *  - `DELETE /api/dms/{dmId}/messages/{messageId}` (tombstone).
 *  - `PUT`/`DELETE /api/dms/{dmId}/messages/{messageId}/reactions/{key}`
 *    (either participant, on either side's message).
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
  DmConversationPointerRequestSchema,
  DmConversationsResponseSchema,
  MessageSchema,
  MessagesPageSchema,
  ReactionSchema,
  canonicalAuthority,
  deriveDmId,
} from "@forumall/shared";
import { Hono } from "hono";
import { listDmMessages } from "../provider/dm-history.ts";
import {
  addDmReaction,
  hasDmReaction,
  listDmReplies,
  removeDmReaction,
  withDmReactions,
} from "../provider/dm-reactions.ts";
import {
  type DmViewer,
  getDmMessageRow,
  isDmThreadParticipant,
  listDmConversations,
  upsertDmPointer,
} from "../provider/dms.ts";
import { isProviderAllowed } from "../provider/federation/policy.ts";
import { assertCanonicalActorField } from "./canonical-fields.ts";
import {
  applyDmDelete,
  applyDmEdit,
  fanOutDmReaction,
  publishDmConversation,
  wireConversation,
} from "./dm-events.ts";
import {
  forwardDmDelete,
  forwardDmEdit,
  forwardDmReaction,
  relayPeerResponse,
} from "./dm-forwarding.ts";
import {
  assertValidReactionKey,
  counterpartyOf,
  dmViewerOf,
  domainOf,
  pageQuery,
  requireParam,
  resolveLocalDmOwner,
} from "./dm-request.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** The `GET /api/me/dms` router. Mounted at `/api/me`. */
export function createMeDmsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  // The conversation list IS the caller's local inbox index (`dm_conversations.
  // owner`), which only a user of this provider has; a remote actor reads its
  // conversations at its own home provider.
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

/**
 * The `/api/dms/{dmId}/messages` router (read + edit/delete). Mounted at
 * `/api/dms`.
 */
export function createDmsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /{dmId}/messages (§7.4 — signed, participant-only) -------------
  // Returns the caller's FULL conversation view the provider can serve: the
  // messages they SENT (rows authored by them, stored in the counterparty's
  // local inbox) ∪ the messages they RECEIVED (their own inbox, when local),
  // over the shared global seq cursor space (§7.4). Works same- and
  // cross-provider (a remote sender reading the recipient's provider gets their
  // sent rows by `author` scope).
  router.get("/:dmId/messages", signed, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const viewer: DmViewer = dmViewerOf(actor);

    // Participation: the caller must own a local inbox row for dmId, OR be named
    // as the counterparty of some local inbox row for dmId (covers an only-sent /
    // cross-provider sender with no inbox here). A true non-participant → 404.
    if (!isDmThreadParticipant(db, dmId, viewer, canonicalAuthority(config.domain))) {
      throw AppError.notFound({ detail: "no such conversation" });
    }

    const { cursor, direction, limit } = pageQuery(c);
    const page = listDmMessages(db, dmId, viewer, {
      cursor,
      direction,
      ...(limit !== undefined ? { limit } : {}),
    });
    // Embed each message's reactions aggregate (attachments + reference already
    // flow through `rowToDmMessage`), so the client has everything in one read.
    return c.json(
      MessagesPageSchema.parse({ items: withDmReactions(db, dmId, page.items), page: page.page }),
    );
  });

  // -- GET /{dmId}/messages/{messageId}/replies (§7.2 — signed) -----------
  // Paged list of the replies to a DM message within the caller's inbox. Same
  // participant-only gate + `messages-page` shape as the history read.
  router.get("/:dmId/messages/:messageId/replies", signed, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const viewer: DmViewer = dmViewerOf(actor);

    if (!isDmThreadParticipant(db, dmId, viewer, canonicalAuthority(config.domain))) {
      throw AppError.notFound({ detail: "no such conversation" });
    }

    const { cursor, direction, limit } = pageQuery(c);
    const page = listDmReplies(db, dmId, messageId, viewer, {
      cursor,
      direction,
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(MessagesPageSchema.parse(page));
  });

  // -- PUT /{dmId}/messages/{messageId}/reactions/{key} (signed) ----------
  // Add the caller's reaction; idempotent (201 first add, 200 repeat). Storage-
  // follows-message (§8.3): a DM is stored ONLY in the recipient's inbox, so what
  // decides where the reaction lands is *where the message lives* — NOT whether
  // the caller happens to own an inbox conversation row. Gating on the latter
  // 404s a participant who has only ever SENT in the conversation (they have no
  // inbox row at all), so they could not react to their own message until the
  // counterparty replied — even though that message is sitting right here in the
  // recipient's inbox.
  //
  // Routing decision table (first match wins; DELETE below is identical):
  //
  //  | # | condition                                        | action                        |
  //  |---|--------------------------------------------------|-------------------------------|
  //  | a | a row for {dmId,messageId} in the CALLER's OWN    | store here; fan out to the    |
  //  |   | inbox (a received copy, or a self/same-node DM)   | caller + that row's cp        |
  //  | b | else a row on THIS node owned by the local user   | store on that copy; fan out   |
  //  |   | `u` with deriveDmId(caller, u@authority)={dmId}   | to the caller + `u@authority` |
  //  | c | else the caller has an inbox row naming a REMOTE  | forward to that peer (§8.1)   |
  //  |   | counterparty                                     |                               |
  //  | d | else                                             | 404 — not stored here         |
  //
  // Unlike the edit/delete table below there is NO authorship condition: §7.1
  // lets EITHER participant react, whoever wrote the message — so (a) and (b)
  // both accept a caller who did not author it, exactly as before this routing.
  //
  // (b) cannot leak: the inbox owner is derived from the CALLER's own actor via
  // the §8.3 dmId derivation, so it only ever resolves a conversation the caller
  // is a participant of — a third party matches no case and falls through to (d).
  // (b) runs before (c) because a dmId fixes its participant pair: a conversation
  // whose counterparty is remote has no local owner to resolve, so the two are
  // mutually exclusive. Note (c) needs the inbox row: with no row we cannot learn
  // the remote counterparty (the dmId is a one-way digest), so an only-sent
  // CROSS-provider participant must address the message's home provider directly
  // (which the client does — see `deliveryClientFor` / the §8.3 federation
  // ingest, which now accepts their own user signature).
  //
  // Fan-out participants differ per case and getting them wrong silently drops
  // the event for the other side: (a) reads the counterparty off the CALLER's
  // conversation row, while (b) has no such row — there the counterparty IS the
  // resolved local inbox owner, `u@authority`.
  //
  // Cases (a) and (c) both key on the caller's OWN LOCAL INBOX (`dm_messages.
  // owner` / `dm_conversations.owner`), so they apply ONLY to a caller that has a
  // local handle. A REMOTE caller (§4.6) has no inbox here — their bare handle
  // names a user of THEIR provider — so they skip straight to (b), which resolves
  // the inbox from their FULL actor via the §8.3 dmId derivation. That keeps the
  // only-sent remote author working exactly as before, while a remote handle can
  // never select the like-named LOCAL user's inbox.
  router.put("/:dmId/messages/:messageId/reactions/:key", signed, async (c) => {
    const { db, config, hub, federationFetch } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const key = requireParam(c, "key");
    assertValidReactionKey(key);
    const authority = canonicalAuthority(config.domain);

    // (a) The target lives in the caller's own LOCAL inbox. Its conversation row is
    // written alongside every stored inbox message, so the counterparty is
    // always resolvable here; were it ever not, we fall through rather than fan
    // out an event that names nobody.
    const me = actor.localHandle;
    const own = me !== undefined ? getDmMessageRow(db, me, dmId, messageId) : null;
    const ownCounterparty =
      me !== undefined && own ? counterpartyOf(db, me, dmId, authority) : null;
    if (own && ownCounterparty !== null) {
      const existed = hasDmReaction(db, dmId, messageId, actor.actor, key);
      const reaction = addDmReaction(db, { dmId, messageId, author: actor.actor, key });
      fanOutDmReaction(hub, {
        dmId,
        messageId,
        state: "added",
        author: actor.actor,
        key,
        reaction,
        participants: [actor.actor, ownCounterparty],
      });
      return c.json(ReactionSchema.parse(reaction), existed ? 200 : 201);
    }

    // (b) The target lives in a LOCAL counterparty's inbox — the caller SENT it.
    const owner = resolveLocalDmOwner(db, config, actor.actor, dmId);
    if (owner !== null && getDmMessageRow(db, owner, dmId, messageId)) {
      const existed = hasDmReaction(db, dmId, messageId, actor.actor, key);
      const reaction = addDmReaction(db, { dmId, messageId, author: actor.actor, key });
      fanOutDmReaction(hub, {
        dmId,
        messageId,
        state: "added",
        author: actor.actor,
        key,
        reaction,
        participants: [actor.actor, `${owner}@${authority}`],
      });
      return c.json(ReactionSchema.parse(reaction), existed ? 200 : 201);
    }

    // (c) The counterparty is REMOTE → the message lives on their provider.
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId, authority) : null;
    const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
    if (cpDomain !== "" && cpDomain !== authority) {
      const res = await forwardDmReaction(db, config, federationFetch, {
        method: "PUT",
        dmId,
        messageId,
        key,
        counterpartyDomain: cpDomain,
        actor: actor.actor,
      });
      return relayPeerResponse(c, res);
    }

    // (d) Not stored here.
    throw AppError.notFound({ detail: "no such message" });
  });

  // -- DELETE /{dmId}/messages/{messageId}/reactions/{key} (signed) -------
  // Remove the caller's reaction → 204. Same storage-follows-message decision
  // table as PUT above, including the per-case fan-out participants; only the
  // stored effect (remove instead of add) differs.
  //
  // Cases (a) and (c) both key on the caller's OWN LOCAL INBOX (`dm_messages.
  // owner` / `dm_conversations.owner`), so they apply ONLY to a caller that has a
  // local handle. A REMOTE caller (§4.6) has no inbox here — their bare handle
  // names a user of THEIR provider — so they skip straight to (b), which resolves
  // the inbox from their FULL actor via the §8.3 dmId derivation. That keeps the
  // only-sent remote author working exactly as before, while a remote handle can
  // never select the like-named LOCAL user's inbox.
  router.delete("/:dmId/messages/:messageId/reactions/:key", signed, async (c) => {
    const { db, config, hub, federationFetch } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const key = requireParam(c, "key");
    assertValidReactionKey(key);
    const authority = canonicalAuthority(config.domain);

    // (a) The target lives in the caller's own LOCAL inbox.
    const me = actor.localHandle;
    const own = me !== undefined ? getDmMessageRow(db, me, dmId, messageId) : null;
    const ownCounterparty =
      me !== undefined && own ? counterpartyOf(db, me, dmId, authority) : null;
    if (own && ownCounterparty !== null) {
      removeDmReaction(db, dmId, messageId, actor.actor, key);
      fanOutDmReaction(hub, {
        dmId,
        messageId,
        state: "removed",
        author: actor.actor,
        key,
        participants: [actor.actor, ownCounterparty],
      });
      return c.body(null, 204);
    }

    // (b) The target lives in a LOCAL counterparty's inbox — the caller SENT it.
    const owner = resolveLocalDmOwner(db, config, actor.actor, dmId);
    if (owner !== null && getDmMessageRow(db, owner, dmId, messageId)) {
      removeDmReaction(db, dmId, messageId, actor.actor, key);
      fanOutDmReaction(hub, {
        dmId,
        messageId,
        state: "removed",
        author: actor.actor,
        key,
        participants: [actor.actor, `${owner}@${authority}`],
      });
      return c.body(null, 204);
    }

    // (c) The counterparty is REMOTE → the message lives on their provider.
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId, authority) : null;
    const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
    if (cpDomain !== "" && cpDomain !== authority) {
      const res = await forwardDmReaction(db, config, federationFetch, {
        method: "DELETE",
        dmId,
        messageId,
        key,
        counterpartyDomain: cpDomain,
        actor: actor.actor,
      });
      return relayPeerResponse(c, res);
    }

    // (d) Not stored here.
    throw AppError.notFound({ detail: "no such message" });
  });

  // -- PATCH /{dmId}/messages/{messageId} (§7.1 edit) ---------------------
  // Author-only + edit window (both enforced by `applyDmEdit`). Storage-follows-
  // message (§8.3): a DM is stored ONLY in the recipient's inbox, so what decides
  // where the edit lands is *where the message lives* — NOT whether the caller
  // happens to own an inbox conversation row. Gating on the latter 404s an author
  // who has only ever SENT in the conversation (they have no inbox row at all),
  // even though their message is sitting right here in the recipient's inbox.
  //
  // Routing decision table (first match wins; DELETE below is identical):
  //
  //  | # | condition                                        | action                        |
  //  |---|--------------------------------------------------|-------------------------------|
  //  | a | a row for {dmId,messageId} in the CALLER's OWN    | apply here, owner = caller    |
  //  |   | inbox (a received copy, or a self/same-node DM)   |                               |
  //  | b | else a row on THIS node owned by the local user   | apply to that copy,           |
  //  |   | `u` with deriveDmId(caller, u@authority)={dmId}   | AUTHOR-ONLY (only-sent case)  |
  //  | c | else the caller has an inbox row naming a REMOTE  | forward to that peer (§8.1)   |
  //  |   | counterparty                                     |                               |
  //  | d | else                                             | 404 — not stored here         |
  //
  // (b) cannot leak: the inbox owner is derived from the CALLER's own actor via
  // the §8.3 dmId derivation, so it only ever resolves a conversation the caller
  // is a participant of — a third party matches no case and falls through to (d).
  // (b) runs before (c) because a dmId fixes its participant pair: a conversation
  // whose counterparty is remote has no local owner to resolve, so the two are
  // mutually exclusive. Note (c) needs the inbox row: with no row we cannot learn
  // the remote counterparty (the dmId is a one-way digest), so an only-sent
  // CROSS-provider author must address the recipient's provider directly (which
  // the client does — see `resolveDeliveryClient` / the §8.3 federation ingest).
  //
  // Cases (a) and (c) both key on the caller's OWN LOCAL INBOX (`dm_messages.
  // owner` / `dm_conversations.owner`), so they apply ONLY to a caller that has a
  // local handle. A REMOTE caller (§4.6) has no inbox here — their bare handle
  // names a user of THEIR provider — so they skip straight to (b), which resolves
  // the inbox from their FULL actor via the §8.3 dmId derivation. That keeps the
  // only-sent remote author working exactly as before, while a remote handle can
  // never select the like-named LOCAL user's inbox.
  router.patch("/:dmId/messages/:messageId", signed, async (c) => {
    const { db, config, hub, federationFetch } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const authority = canonicalAuthority(config.domain);

    // The `MessageUpdate` body is checked only once the message is found (else
    // 404) and the caller is its author within the edit window (else 403): by
    // `applyDmEdit` for (a)/(b), by the peer for (c), which gets it in full.
    const body: unknown = await c.req.json().catch(() => undefined);

    // (a) The target lives in the caller's own LOCAL inbox.
    const me = actor.localHandle;
    const own = me !== undefined ? getDmMessageRow(db, me, dmId, messageId) : null;
    if (me !== undefined && own) {
      const message = applyDmEdit(db, config, hub, {
        owner: me,
        ownerActor: actor.actor,
        dmId,
        messageId,
        actor: actor.actor,
        body,
        row: own,
      });
      return c.json(MessageSchema.parse(message));
    }

    // (b) The target lives in a LOCAL counterparty's inbox — the caller SENT it.
    const owner = resolveLocalDmOwner(db, config, actor.actor, dmId);
    const row = owner !== null ? getDmMessageRow(db, owner, dmId, messageId) : null;
    if (owner !== null && row) {
      const message = applyDmEdit(db, config, hub, {
        owner,
        ownerActor: `${owner}@${authority}`,
        dmId,
        messageId,
        actor: actor.actor,
        body,
        row,
      });
      return c.json(MessageSchema.parse(message));
    }

    // (c) The counterparty is REMOTE → the message lives on their provider.
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId, authority) : null;
    const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
    if (cpDomain !== "" && cpDomain !== authority) {
      const res = await forwardDmEdit(db, config, federationFetch, {
        dmId,
        messageId,
        counterpartyDomain: cpDomain,
        actor: actor.actor,
        update: typeof body === "object" && body !== null && !Array.isArray(body) ? body : {},
      });
      return relayPeerResponse(c, res);
    }

    // (d) Not stored here.
    throw AppError.notFound({ detail: "no such message" });
  });

  // -- DELETE /{dmId}/messages/{messageId} (§7.1 tombstone) --------------
  // Same storage-follows-message decision table as PATCH above. The two cases
  // differ in WHO may tombstone: (a) the caller's own inbox copy may be deleted
  // by its owner regardless of authorship (delete-from-my-inbox), while (b) a
  // copy sitting in the counterparty's inbox is author-only — mirroring the
  // federation ingest.
  //
  // Cases (a) and (c) both key on the caller's OWN LOCAL INBOX (`dm_messages.
  // owner` / `dm_conversations.owner`), so they apply ONLY to a caller that has a
  // local handle. A REMOTE caller (§4.6) has no inbox here — their bare handle
  // names a user of THEIR provider — so they skip straight to (b), which resolves
  // the inbox from their FULL actor via the §8.3 dmId derivation. That keeps the
  // only-sent remote author working exactly as before, while a remote handle can
  // never select the like-named LOCAL user's inbox.
  router.delete("/:dmId/messages/:messageId", signed, async (c) => {
    const { db, config, hub, federationFetch } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const authority = canonicalAuthority(config.domain);

    // (a) The target lives in the caller's own LOCAL inbox.
    const me = actor.localHandle;
    const own = me !== undefined ? getDmMessageRow(db, me, dmId, messageId) : null;
    if (me !== undefined && own) {
      applyDmDelete(db, hub, {
        owner: me,
        ownerActor: actor.actor,
        dmId,
        messageId,
        actor: actor.actor,
        row: own,
        requireAuthor: false,
      });
      return c.body(null, 204);
    }

    // (b) The target lives in a LOCAL counterparty's inbox — the caller SENT it.
    const owner = resolveLocalDmOwner(db, config, actor.actor, dmId);
    const row = owner !== null ? getDmMessageRow(db, owner, dmId, messageId) : null;
    if (owner !== null && row) {
      applyDmDelete(db, hub, {
        owner,
        ownerActor: `${owner}@${authority}`,
        dmId,
        messageId,
        actor: actor.actor,
        row,
        requireAuthor: true,
      });
      return c.body(null, 204);
    }

    // (c) The counterparty is REMOTE → the message lives on their provider.
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId, authority) : null;
    const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
    if (cpDomain !== "" && cpDomain !== authority) {
      const res = await forwardDmDelete(db, config, federationFetch, {
        dmId,
        messageId,
        counterpartyDomain: cpDomain,
        actor: actor.actor,
      });
      return relayPeerResponse(c, res);
    }

    // (d) Not stored here.
    throw AppError.notFound({ detail: "no such message" });
  });

  return router;
}
