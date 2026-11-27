/**
 * DM edit and delete routes (§7.4 "Edits & deletes", §7.1 rules):
 * `PATCH`/`DELETE /api/dms/{dmId}/messages/{messageId}`, applied to the stored
 * copy wherever it lives.
 */
import { MessageSchema, canonicalAuthority } from "@forumall/shared";
import type { Hono } from "hono";
import { getDmMessageRow } from "../provider/dms.ts";
import { applyDmDelete, applyDmEdit } from "./dm-events.ts";
import { forwardDmDelete, forwardDmEdit, relayPeerResponse } from "./dm-forwarding.ts";
import { counterpartyOf, domainOf, requireParam, resolveLocalDmOwner } from "./dm-request.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Register the edit (`PATCH`) and delete routes on the `/api/dms` router. */
export function registerDmEditRoutes(router: Hono<AppBindings>): void {
  const signed = requireSignature();

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
}
