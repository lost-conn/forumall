/**
 * DM reaction routes (§7.4 "Reactions"): `PUT`/`DELETE
 * /api/dms/{dmId}/messages/{messageId}/reactions/{key}`, either participant, on
 * either side's message, wherever that message is stored.
 */
import { ReactionSchema, canonicalAuthority } from "@forumall/shared";
import type { Context, Hono } from "hono";
import { addDmReaction, hasDmReaction, removeDmReaction } from "../provider/dm-reactions.ts";
import { getDmMessageRow } from "../provider/dms.ts";
import { fanOutDmReaction } from "./dm-events.ts";
import { forwardDmReaction, relayPeerResponse } from "./dm-forwarding.ts";
import {
  assertValidReactionKey,
  counterpartyOf,
  domainOf,
  requireParam,
  resolveLocalDmOwner,
} from "./dm-request.ts";
import { AppError } from "./errors.ts";
import { reactionExtras, readReactionPutBody } from "./reaction-body.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * Register the reaction routes on the `/api/dms` router.
 *
 * `PUT` adds the caller's reaction; idempotent (201 first add, 200 repeat).
 * `DELETE` removes it → 204. Storage-follows-message (§8.3): a DM is stored
 * ONLY in the recipient's inbox, so what decides where the reaction lands is
 * *where the message lives* — NOT whether the caller happens to own an inbox
 * conversation row. Gating on the latter 404s a participant who has only ever
 * SENT in the conversation (they have no inbox row at all), so they could not
 * react to their own message until the counterparty replied — even though that
 * message is sitting right here in the recipient's inbox.
 *
 * Routing decision table (first match wins; identical for PUT and DELETE):
 *
 *  | # | condition                                        | action                        |
 *  |---|--------------------------------------------------|-------------------------------|
 *  | a | a row for {dmId,messageId} in the CALLER's OWN    | store here; fan out to the    |
 *  |   | inbox (a received copy, or a self/same-node DM)   | caller + that row's cp        |
 *  | b | else a row on THIS node owned by the local user   | store on that copy; fan out   |
 *  |   | `u` with deriveDmId(caller, u@authority)={dmId}   | to the caller + `u@authority` |
 *  | c | else the caller has an inbox row naming a REMOTE  | forward to that peer (§8.1)   |
 *  |   | counterparty                                     |                               |
 *  | d | else                                             | 404 — not stored here         |
 *
 * Unlike the edit/delete table there is NO authorship condition: §7.1 lets
 * EITHER participant react, whoever wrote the message.
 *
 * (b) cannot leak: the inbox owner is derived from the CALLER's own actor via
 * the §8.3 dmId derivation, so it only ever resolves a conversation the caller
 * is a participant of — a third party matches no case and falls through to (d),
 * the same 404 an unknown dmId gets. (b) runs before (c) because a dmId fixes
 * its participant pair: a conversation whose counterparty is remote has no
 * local owner to resolve, so the two are mutually exclusive. (c) needs the
 * inbox row: with no row we cannot learn the remote counterparty (the dmId is a
 * one-way digest), so an only-sent CROSS-provider participant must address the
 * message's home provider directly (the §8.3 federation ingest accepts their
 * own user signature).
 *
 * Fan-out participants differ per case: (a) reads the counterparty off the
 * CALLER's conversation row, while (b) has no such row — there the
 * counterparty IS the resolved local inbox owner. {@link fanOutDmReaction}
 * delivers implicitly to the local ones and to the message author's `dmId`
 * subscriptions.
 *
 * Cases (a) and (c) key on the caller's OWN LOCAL INBOX, so they apply ONLY to
 * a caller with a local handle. A REMOTE caller (§4.6) has no inbox here — their
 * bare handle names a user of THEIR provider — so they skip straight to (b),
 * which resolves the inbox from their FULL actor; a remote handle can never
 * select the like-named LOCAL user's inbox.
 */
export function registerDmReactionRoutes(router: Hono<AppBindings>): void {
  const signed = requireSignature();
  router.put("/:dmId/messages/:messageId/reactions/:key", signed, (c) =>
    handleDmReaction(c, "added"),
  );
  router.delete("/:dmId/messages/:messageId/reactions/:key", signed, (c) =>
    handleDmReaction(c, "removed"),
  );
}

/** One add/remove through the decision table of {@link registerDmReactionRoutes}. */
async function handleDmReaction(
  c: Context<AppBindings>,
  state: "added" | "removed",
): Promise<Response> {
  const { db, config, hub, federationFetch } = c.var;
  const actor = c.var.actor;
  if (!actor) throw AppError.unauthorized();
  const dmId = requireParam(c, "dmId");
  const messageId = requireParam(c, "messageId");
  const key = requireParam(c, "key");
  assertValidReactionKey(key);
  // A PUT's optional body (§7.1, `reaction-put-request.json`) is checked here
  // for a clean 400 before any routing, then stored or forwarded with it.
  const extras = state === "added" ? reactionExtras(await readReactionPutBody(c)) : {};
  const authority = canonicalAuthority(config.domain);

  // Store (or remove) on a local copy and fan out; the reply is the §7.1 one.
  const applyHere = (messageAuthor: string, counterparty: string): Response => {
    if (state === "removed") {
      removeDmReaction(db, dmId, messageId, actor.actor, key);
      fanOutDmReaction(hub, {
        dmId,
        messageId,
        messageAuthor,
        state,
        author: actor.actor,
        key,
        participants: [actor.actor, counterparty],
        authority,
      });
      return c.body(null, 204);
    }
    const existed = hasDmReaction(db, dmId, messageId, actor.actor, key);
    const reaction = addDmReaction(db, { dmId, messageId, author: actor.actor, key, ...extras });
    fanOutDmReaction(hub, {
      dmId,
      messageId,
      messageAuthor,
      state,
      author: actor.actor,
      key,
      reaction,
      participants: [actor.actor, counterparty],
      authority,
    });
    return c.json(ReactionSchema.parse(reaction), existed ? 200 : 201);
  };

  // (a) The target lives in the caller's own LOCAL inbox. Its conversation row
  // is written alongside every stored inbox message, so the counterparty is
  // always resolvable here; were it ever not, we fall through rather than fan
  // out an event that names nobody.
  const me = actor.localHandle;
  const own = me !== undefined ? getDmMessageRow(db, me, dmId, messageId) : null;
  const ownCounterparty = me !== undefined && own ? counterpartyOf(db, me, dmId, authority) : null;
  if (own && ownCounterparty !== null) return applyHere(own.author, ownCounterparty);

  // (b) The target lives in a LOCAL counterparty's inbox — the caller SENT it.
  const owner = resolveLocalDmOwner(db, config, actor.actor, dmId);
  const row = owner !== null ? getDmMessageRow(db, owner, dmId, messageId) : null;
  if (owner !== null && row) return applyHere(row.author, `${owner}@${authority}`);

  // (c) The counterparty is REMOTE → the message lives on their provider.
  const counterparty = me !== undefined ? counterpartyOf(db, me, dmId, authority) : null;
  const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
  if (cpDomain !== "" && cpDomain !== authority) {
    const res = await forwardDmReaction(db, config, federationFetch, {
      method: state === "added" ? "PUT" : "DELETE",
      dmId,
      messageId,
      key,
      counterpartyDomain: cpDomain,
      actor: actor.actor,
      ...extras,
    });
    return relayPeerResponse(c, res);
  }

  // (d) Not stored here.
  throw AppError.notFound({ detail: "no such message" });
}
