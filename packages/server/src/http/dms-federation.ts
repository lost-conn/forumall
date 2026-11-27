/**
 * The federation DM ingest router (`/api/federation/dms`, §7.4, §8.3): the
 * single DM send path plus the edit/delete/reaction ingest, user- or provider-
 * signed.
 */
import {
  DmMessageCreateRequestSchema,
  MessageSchema,
  ReactionSchema,
  canonicalAuthority,
  deriveDmId,
} from "@forumall/shared";
import { type Context, Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { addDmReaction, removeDmReaction } from "../provider/dm-reactions.ts";
import {
  getDmMessageByClientId,
  getDmMessageRow,
  storeDmMessage,
  upsertDmPointer,
} from "../provider/dms.ts";
import { getUserRow } from "../provider/guests.ts";
import { previewText, sendPushToRecipient } from "../provider/push-send.ts";
import { assertCanonicalActorField } from "./canonical-fields.ts";
import {
  applyDmDelete,
  applyDmEdit,
  fanOutDmReaction,
  publishDmConversation,
  publishDmMessage,
} from "./dm-events.ts";
import {
  assertValidReactionKey,
  domainOf,
  requireParam,
  resolveLocalDmOwner,
} from "./dm-request.ts";
import { AppError, parseRequestBody } from "./errors.ts";
import { checkCreateFields } from "./message-fields.ts";
import { reactionExtras, readReactionPutBody } from "./reaction-body.ts";
import { requireActorOrProviderSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

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

    const body = parseRequestBody(DmMessageCreateRequestSchema, await c.req.json());

    // --- Recipient resolution + §8.3 {dmId} verification -------------------
    // With `to` (OFSCP §7.4), the recipient is named: it must be a LOCAL user
    // and {dmId} must derive from (author, to) — O(1). Without it (older
    // clients), the recipient is the LOCAL user `u` whose derived dmId with the
    // author equals {dmId}, found by scanning local users. Either way a
    // mismatch → 400 (inbox poisoning).
    const authority = canonicalAuthority(config.domain);
    let owner: string | null = null;
    if (body.to !== undefined) {
      assertCanonicalActorField(body.to, "to");
      const at = body.to.lastIndexOf("@");
      const toHandle = at > 0 ? body.to.slice(0, at) : "";
      const toDomain = at > 0 ? canonicalAuthority(body.to.slice(at + 1)) : "";
      if (
        toDomain === authority &&
        getUserRow(db, toHandle) &&
        deriveDmId(author, `${toHandle}@${authority}`) === dmId
      ) {
        owner = toHandle;
      }
    } else {
      const localUsers = db.drizzle.select({ handle: users.handle }).from(users).all();
      for (const u of localUsers) {
        if (deriveDmId(author, `${u.handle}@${authority}`) === dmId) {
          owner = u.handle;
          break;
        }
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

    // --- The §5.8 attachment checks and canonical mentions (new only) -------
    // A DM is a `message`, never an `article` (§7.4), so no article fields.
    const checked = checkCreateFields(db, config, author, "message", body);
    if (checked.error) throw AppError.badRequest({ detail: checked.error.message });
    const { fields } = checked;

    // --- Store in the recipient's inbox (only here — no sender copy) -------
    const record = storeDmMessage(db, config, {
      owner,
      dmId,
      author,
      content: body.content,
      attachments: fields.attachments,
      ...(body.reference !== undefined ? { reference: body.reference } : {}),
      ...(fields.mentions !== undefined ? { mentions: fields.mentions } : {}),
      clientMessageId: body.clientMessageId,
    });

    // --- Real-time: `dm.message` (§7.4) -------------------------------------
    // Implicitly to every connection of the recipient (only their inbox stored
    // it), and to the author's `dmId` subscriptions here, if any — the sender
    // follows their sent messages on the recipient's provider that way.
    publishDmMessage(hub, { dmId, ownerActor: recipientActor, record });

    // --- Sender's conversation pointer (§7.4) when the sender is LOCAL -------
    // A remote sender's client records the pointer at its own home provider
    // (PUT /api/me/dms/{dmId}); a local sender's home provider is this one, so
    // record it here and tell the sender's other devices.
    const authorAt = author.lastIndexOf("@");
    const authorHandle = authorAt > 0 ? author.slice(0, authorAt) : "";
    if (
      authorAt > 0 &&
      canonicalAuthority(author.slice(authorAt + 1)) === authority &&
      authorHandle !== owner
    ) {
      upsertDmPointer(db, `${authorHandle}@${authority}`, dmId, recipientActor, record.message);
      publishDmConversation(hub, db, author, authorHandle, dmId);
    }

    // --- Web Push: notify a DISCONNECTED recipient (no live WS) -------------
    // Gate strictly on liveConnectionCount === 0 (a connected recipient already
    // got the in-app dm.message). Fire-and-forget — never block/fail the send.
    if (hub.liveConnectionCount(recipientActor) === 0) {
      const authorHandle = author.includes("@") ? author.slice(0, author.lastIndexOf("@")) : author;
      const text =
        typeof (body.content as { text?: unknown }).text === "string"
          ? (body.content as { text: string }).text
          : "";
      void sendPushToRecipient(db, config, recipientActor, {
        title: authorHandle,
        body: previewText(text),
        tag: `dm:${dmId}`,
        data: { type: "dm", dmId, messageId: record.message.id, targetUrl: `/dms/${dmId}` },
      });
    }

    // Respond with the stored canonical message (the local sender's confirmation;
    // the sender still keeps its own optimistic copy client-side, §7.4).
    return c.json(MessageSchema.parse(record.message), 201);
  });

  // -- Federation edit/delete/reaction ingest (§8.3 storage-follows-message)
  // The same operation arrives here in EITHER of the two §8.3 delivery shapes,
  // so both signatures are accepted on every route below (see
  // {@link federationActingActor}):
  //  - **user-signed** (§4.4) — "the author signs and delivers to the message's
  //    home provider": the AUTHOR (or, for a reaction, either participant) calls
  //    us directly about a message that lives in a LOCAL recipient's inbox. The
  //    acting actor is the authenticated actor; a body `actor` is ignored.
  //  - **provider-signed** (§8.1) — a peer forwards the operation on behalf of
  //    one of THEIR users; the acting actor travels in the body (a
  //    provider-signed request carries no `X-OFSCP-Actor`) and must belong to
  //    that peer — a domain mismatch is a 403, so provider A cannot act as a
  //    user of provider B.
  // Either way we re-derive the local inbox owner from (actor, dmId) — the
  // derivation the send ingest applies; a non-participant gets the unknown-dmId
  // 404 — apply to the stored copy (edit/delete additionally enforcing §7.1
  // author-only + the edit window), and fan out the resulting `dm.message` /
  // `dm.reaction`.
  const actorOrProviderSigned = requireActorOrProviderSignature();

  // PUT /{dmId}/messages/{messageId}/reactions/{key}
  router.put("/:dmId/messages/:messageId/reactions/:key", actorOrProviderSigned, async (c) =>
    handleFederationDmReaction(c, "added"),
  );

  // DELETE /{dmId}/messages/{messageId}/reactions/{key}
  router.delete("/:dmId/messages/:messageId/reactions/:key", actorOrProviderSigned, async (c) =>
    handleFederationDmReaction(c, "removed"),
  );

  // PATCH /{dmId}/messages/{messageId}
  router.patch("/:dmId/messages/:messageId", actorOrProviderSigned, async (c) => {
    const { db, config, hub } = c.var;
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");

    // The body is the `MessageUpdate` (plus `actor` when provider-signed). It
    // is checked only after the message is found (404) and the actor is its
    // author within the edit window (403), in `applyDmEdit`.
    const body: unknown = await c.req.json().catch(() => undefined);
    const bodyActor =
      typeof body === "object" && body !== null ? (body as { actor?: unknown }).actor : undefined;
    const actingActor = federationActingActor(c, bodyActor);

    const { owner, ownerActor } = resolveFederationDmOwner(db, config, actingActor, dmId);
    const row = getDmMessageRow(db, owner, dmId, messageId);
    if (!row) throw AppError.notFound({ detail: "no such message" });

    const message = applyDmEdit(db, config, hub, {
      owner,
      ownerActor,
      dmId,
      messageId,
      actor: actingActor,
      body,
      row,
    });
    return c.json(MessageSchema.parse(message));
  });

  // DELETE /{dmId}/messages/{messageId}
  router.delete("/:dmId/messages/:messageId", actorOrProviderSigned, async (c) => {
    const { db, config, hub } = c.var;
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");

    const raw = (await c.req.json().catch(() => ({}))) as { actor?: unknown };
    const actingActor = federationActingActor(c, raw.actor);

    const { owner, ownerActor } = resolveFederationDmOwner(db, config, actingActor, dmId);
    const row = getDmMessageRow(db, owner, dmId, messageId);
    if (!row) throw AppError.notFound({ detail: "no such message" });

    applyDmDelete(db, hub, {
      owner,
      ownerActor,
      dmId,
      messageId,
      actor: actingActor,
      row,
      requireAuthor: true,
    });
    return c.body(null, 204);
  });

  return router;
}

/**
 * The acting user of a federation DM edit/delete/reaction ingest, derived from
 * **how the request was signed** — never from an unauthenticated claim:
 *
 *  - **user-signed** (§4.4 / §8.3 "the author signs and delivers to the
 *    message's home provider"): the acting actor IS the authenticated actor. A
 *    body `actor` field is IGNORED — a signed-in user may only act as itself, so
 *    naming someone else buys nothing.
 *  - **provider-signed** (§8.1 peer forward): the request carries no
 *    `X-OFSCP-Actor`, so the peer names its user in the body. A peer is trusted
 *    for its OWN users only, so the named actor's domain MUST equal the signing
 *    provider's domain (403 otherwise); a missing/blank actor is a 400.
 *
 * Downstream, `resolveFederationDmOwner` / the reaction handler's equivalent
 * still applies the §8.3 dmId guard, and `applyDmEdit`/`applyDmDelete` still
 * enforce §7.1 author-only + the edit window against the stored copy — this only
 * decides WHO is acting.
 */
function federationActingActor(c: Context<AppBindings>, bodyActor: unknown): string {
  const signer = c.var.actor;
  if (!signer) throw AppError.unauthorized();
  if (c.var.signatureMode !== "provider") return signer.actor;

  const actingActor = typeof bodyActor === "string" ? bodyActor : "";
  if (actingActor === "") throw AppError.badRequest({ detail: "missing acting actor" });
  assertCanonicalActorField(actingActor, "actor");
  if (domainOf(actingActor) !== signer.domain) {
    throw AppError.forbidden({ detail: "a provider may only act on behalf of its own users" });
  }
  return actingActor;
}

/**
 * Resolve the LOCAL inbox owner for a federation DM edit/delete/reaction: the
 * local user `u` such that `deriveDmId(actingActor, u@authority) === dmId`,
 * which is exactly what makes the actor a participant (§7.4). No match means
 * the actor is not a participant — or the `dmId` is unknown, indistinguishably
 * — and is answered `404`, the same "no such message" as a missing message, so
 * the reply never reveals whether a conversation exists (§7.4 "Non-participants
 * answer as unknown"). Returns both the bare handle and the full actor.
 */
function resolveFederationDmOwner(
  db: Db,
  config: Config,
  actingActor: string,
  dmId: string,
): { owner: string; ownerActor: string } {
  const owner = resolveLocalDmOwner(db, config, actingActor, dmId);
  if (owner === null) throw AppError.notFound({ detail: "no such message" });
  const authority = canonicalAuthority(config.domain);
  return { owner, ownerActor: `${owner}@${authority}` };
}

/**
 * Shared handler for the federation DM-reaction ingest (add/remove). The message
 * lives in a LOCAL recipient's inbox and the reaction reaches us in either §8.3
 * delivery shape — user-signed by the reacting participant, or provider-signed
 * by their home provider (see {@link federationActingActor}). We re-derive the
 * local owner from `(actor, dmId)` ({@link resolveFederationDmOwner}: 404 for a
 * non-participant, as for an unknown dmId), store/remove, then fan out.
 */
async function handleFederationDmReaction(
  c: Context<AppBindings>,
  state: "added" | "removed",
): Promise<Response> {
  const { db, config, hub } = c.var;
  const dmId = requireParam(c, "dmId");
  const messageId = requireParam(c, "messageId");
  const key = requireParam(c, "key");
  assertValidReactionKey(key);

  // A PUT takes the optional reaction body (§7.1/§8.3,
  // `reaction-put-request.json`): absent or empty is fine, anything else is
  // checked (400 on a mismatch). A DELETE may legitimately arrive with no body
  // at all, hence the catch. Either may carry the provider-signed `actor`.
  const body: { actor?: unknown; unicode?: string; image?: string } =
    state === "added"
      ? await readReactionPutBody(c)
      : ((await c.req.json().catch(() => ({}))) as { actor?: unknown });
  // User-signed → the reacting actor IS the signer and `body.actor` is ignored;
  // provider-signed → the named actor's domain must equal the signing
  // provider's domain, binding the body actor to the peer that signed the
  // request (a peer may only act on behalf of its own users), and a
  // missing/blank actor is a 400. See {@link federationActingActor}.
  const reactingActor = federationActingActor(c, body.actor);

  // The local inbox owner, or the unknown-dmId 404 for a non-participant.
  const { owner, ownerActor: recipientActor } = resolveFederationDmOwner(
    db,
    config,
    reactingActor,
    dmId,
  );
  const authority = canonicalAuthority(config.domain);

  const row = getDmMessageRow(db, owner, dmId, messageId);
  if (!row) throw AppError.notFound({ detail: "no such message" });

  if (state === "added") {
    const reaction = addDmReaction(db, {
      dmId,
      messageId,
      author: reactingActor,
      key,
      ...reactionExtras(body),
    });
    fanOutDmReaction(hub, {
      dmId,
      messageId,
      state: "added",
      author: reactingActor,
      key,
      reaction,
      messageAuthor: row.author,
      participants: [recipientActor, reactingActor],
      authority,
    });
    return c.json(ReactionSchema.parse(reaction), 200);
  }

  removeDmReaction(db, dmId, messageId, reactingActor, key);
  fanOutDmReaction(hub, {
    dmId,
    messageId,
    state: "removed",
    author: reactingActor,
    key,
    messageAuthor: row.author,
    participants: [recipientActor, reactingActor],
    authority,
  });
  return c.body(null, 204);
}
