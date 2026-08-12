/**
 * Direct-message routers (spec §7.4, §8.3).
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
  type Content,
  DmConversationSchema,
  DmConversationsResponseSchema,
  DmMessageCreateRequestSchema,
  type Message,
  MessageSchema,
  MessageUpdateRequestSchema,
  MessagesPageSchema,
  PagedResponseSchema,
  type Reaction,
  ReactionSchema,
  WsDmMessageSchema,
  WsDmReactionSchema,
  canonicalAuthority,
  deriveDmId,
  rfc3339Timestamp,
} from "@forumall/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import {
  addDmReaction,
  hasDmReaction,
  listDmReplies,
  removeDmReaction,
  withDmReactions,
} from "../provider/dm-reactions.ts";
import {
  type DmViewer,
  getDmConversationRow,
  getDmMessageByClientId,
  getDmMessageRow,
  isDmThreadParticipant,
  listDmConversations,
  listDmMessages,
  storeDmMessage,
  tombstoneDmMessage,
  updateDmMessageContent,
} from "../provider/dms.ts";
import type { FederationFetch } from "../provider/federation/http.ts";
import { signedProviderFetch } from "../provider/federation/http.ts";
import { previewText, sendPushToRecipient } from "../provider/push-send.ts";
import { AppError } from "./errors.ts";
import {
  requireActorOrProviderSignature,
  requireLocalActor,
  requireLocalHandle,
  requireSignature,
} from "./signature.ts";
import type { AppBindings, AuthenticatedActor } from "./types.ts";

/** Max length of a reaction key (matches the channel reaction key bound). */
const MAX_REACTION_KEY_LENGTH = 64;

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
      // Carry attachments / reply reference + edit/delete markers on the live
      // event so a DM with media or a reply renders without a re-fetch.
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.reference ? { reference: message.reference } : {}),
      ...(message.editedAt ? { editedAt: message.editedAt } : {}),
      ...(message.deletedAt ? { deletedAt: message.deletedAt } : {}),
    },
  });
}

/**
 * Resolve the LOCAL inbox owner for a `(author, dmId)` pair — the local user
 * `u` whose derived dmId with `author` equals `dmId` (§8.3 recipient
 * resolution, O(n) over local users). Returns the bare local handle, or `null`
 * if no local user is the recipient (i.e. the inbox lives on a remote provider).
 */
function resolveLocalDmOwner(db: Db, config: Config, author: string, dmId: string): string | null {
  const authority = canonicalAuthority(config.domain);
  const localUsers = db.drizzle.select({ handle: users.handle }).from(users).all();
  for (const u of localUsers) {
    if (deriveDmId(author, `${u.handle}@${authority}`) === dmId) return u.handle;
  }
  return null;
}

/**
 * The other actor in `dmId` from the perspective of the LOCAL inbox `owner`, or
 * `null`. `owner` is a local handle (the inbox key) — a remote caller has no
 * inbox here, so callers must not reach for this with a foreign handle.
 */
function counterpartyOf(db: Db, owner: string, dmId: string): string | null {
  return getDmConversationRow(db, owner, dmId)?.counterparty ?? null;
}

/**
 * The {@link DmViewer} for an authenticated caller. A LOCAL caller sees both what
 * they authored and their own inbox; a REMOTE caller (§4.6) — legitimately
 * reading/mutating a thread on the recipient's provider (§8.3) — is scoped to the
 * rows they AUTHORED, never to a local inbox that merely shares their handle.
 */
function dmViewerOf(actor: AuthenticatedActor): DmViewer {
  return {
    actor: actor.actor,
    ...(actor.localHandle !== undefined ? { localHandle: actor.localHandle } : {}),
  };
}

/** The host (domain) part of `handle@domain`, canonicalized; "" if malformed. */
function domainOf(actor: string): string {
  const at = actor.lastIndexOf("@");
  if (at <= 0 || at === actor.length - 1) return "";
  return canonicalAuthority(actor.slice(at + 1));
}

/** Build a validated `dm.reaction` event payload (added/removed). */
function dmReactionEventData(args: {
  dmId: string;
  messageId: string;
  state: "added" | "removed";
  author: string;
  key: string;
  reaction?: Reaction;
}): unknown {
  return WsDmReactionSchema.shape.data.parse({
    dmId: args.dmId,
    messageId: args.messageId,
    state: args.state,
    author: args.author,
    key: args.key,
    ...(args.reaction ? { reaction: args.reaction } : {}),
  });
}

/** Reject an empty / over-long reaction key with a clean 400 (mirrors channels). */
function assertValidReactionKey(key: string): void {
  if (key.length === 0 || key.length > MAX_REACTION_KEY_LENGTH) {
    throw AppError.badRequest({ detail: "invalid reaction key" });
  }
}

/** The hub surface the DM routes use for fan-out (publish to a specific actor). */
type DmHub = { publishToActor(actor: string, event: { type: string; data: unknown }): void };

/**
 * Fan out a `dm.reaction` event to BOTH participants of the conversation
 * (mirroring the `publishToActor`-per-participant DM-send delivery). Dedupes so
 * a fully-local both-parties pair isn't notified twice.
 */
function fanOutDmReaction(
  hub: DmHub,
  args: {
    dmId: string;
    messageId: string;
    state: "added" | "removed";
    author: string;
    key: string;
    reaction?: Reaction;
    participants: string[];
  },
): void {
  const data = dmReactionEventData({
    dmId: args.dmId,
    messageId: args.messageId,
    state: args.state,
    author: args.author,
    key: args.key,
    ...(args.reaction ? { reaction: args.reaction } : {}),
  });
  for (const actor of new Set(args.participants)) {
    hub.publishToActor(actor, { type: "dm.reaction", data });
  }
}

/**
 * Forward a DM reaction add/remove to the counterparty's home provider via a
 * provider-signed request (§8.1), mirroring the DM-send delivery path: the
 * reaction targets a message stored only in the remote recipient's inbox
 * (storage-follows-message, §8.3), so the authoritative store is the peer. The
 * reacting actor travels in the JSON body (a provider-signed request has no
 * `X-OFSCP-Actor`); the peer re-validates dmId membership.
 */
async function forwardDmReaction(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  args: {
    method: "PUT" | "DELETE";
    dmId: string;
    messageId: string;
    key: string;
    counterpartyDomain: string;
    actor: string;
  },
): Promise<Response> {
  const path = `/api/federation/dms/${args.dmId}/messages/${args.messageId}/reactions/${encodeURIComponent(args.key)}`;
  const url = `https://${args.counterpartyDomain}${path}`;
  const body = JSON.stringify({ actor: args.actor });
  return signedProviderFetch(
    db,
    config,
    {
      method: args.method,
      url,
      body,
      headers: { "content-type": "application/json" },
    },
    federationFetch,
  );
}

/**
 * Forward an edit of a sent DM to the counterparty's home provider (§8.1),
 * mirroring {@link forwardDmReaction}: the message lives only in the remote
 * recipient's inbox (storage-follows-message, §8.3), so the authoritative store
 * is the peer. The acting actor + the new content travel in the body (a
 * provider-signed request has no `X-OFSCP-Actor`); the peer re-validates dmId
 * membership and enforces author-only + the edit window.
 */
async function forwardDmEdit(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  args: {
    dmId: string;
    messageId: string;
    counterpartyDomain: string;
    actor: string;
    content: Content;
  },
): Promise<Response> {
  const path = `/api/federation/dms/${args.dmId}/messages/${args.messageId}`;
  const url = `https://${args.counterpartyDomain}${path}`;
  const body = JSON.stringify({ actor: args.actor, content: args.content });
  return signedProviderFetch(
    db,
    config,
    { method: "PATCH", url, body, headers: { "content-type": "application/json" } },
    federationFetch,
  );
}

/**
 * Forward a delete (tombstone) of a sent DM to the counterparty's home provider
 * (§8.1), mirroring {@link forwardDmEdit}. The acting actor travels in the body;
 * the peer enforces author-only against the stored copy.
 */
async function forwardDmDelete(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  args: {
    dmId: string;
    messageId: string;
    counterpartyDomain: string;
    actor: string;
  },
): Promise<Response> {
  const path = `/api/federation/dms/${args.dmId}/messages/${args.messageId}`;
  const url = `https://${args.counterpartyDomain}${path}`;
  const body = JSON.stringify({ actor: args.actor });
  return signedProviderFetch(
    db,
    config,
    { method: "DELETE", url, body, headers: { "content-type": "application/json" } },
    federationFetch,
  );
}

/**
 * Apply an edit to a stored inbox DM after the author + edit-window checks pass,
 * then fan `dm.message` to the inbox owner. Shared by the local PATCH path and
 * the federation ingest so both enforce identical §7.1 rules. `row` is the
 * pre-fetched stored row (already asserted to exist). Throws 403 if the acting
 * actor is not the author or the edit window has passed.
 */
function applyDmEdit(
  db: Db,
  hub: DmHub,
  args: {
    owner: string;
    ownerActor: string;
    dmId: string;
    messageId: string;
    actor: string;
    content: Content;
    row: { author: string; editUntil: number };
  },
): Message {
  if (args.row.author !== args.actor) {
    throw AppError.forbidden({ detail: "only the author may edit this message" });
  }
  if (Date.now() > args.row.editUntil) {
    throw AppError.forbidden({ detail: "the edit window for this message has passed" });
  }
  const record = updateDmMessageContent(db, args.owner, args.dmId, args.messageId, args.content);
  hub.publishToActor(args.ownerActor, {
    type: "dm.message",
    data: dmMessageEventData(args.dmId, record.cursor, record.message),
  });
  return record.message;
}

/**
 * Tombstone a stored inbox DM, then fan `dm.message` to the inbox owner. Shared
 * by the local DELETE path and the federation ingest.
 *
 * `requireAuthor` controls the §7.1 authorization: it is `false` for the local
 * own-inbox path (the inbox owner may delete their OWN stored copy — preserving
 * the original DM-delete semantics where a recipient can tombstone a received
 * message in their inbox), and `true` for the forwarded / federation-ingest path
 * (a sender deleting a message they SENT that lives in the counterparty's inbox
 * — only the ORIGINAL AUTHOR may do so; else 403).
 */
function applyDmDelete(
  db: Db,
  hub: DmHub,
  args: {
    owner: string;
    ownerActor: string;
    dmId: string;
    messageId: string;
    actor: string;
    row: { author: string };
    requireAuthor: boolean;
  },
): void {
  if (args.requireAuthor && args.row.author !== args.actor) {
    throw AppError.forbidden({ detail: "only the author may delete this message" });
  }
  const record = tombstoneDmMessage(db, args.owner, args.dmId, args.messageId);
  hub.publishToActor(args.ownerActor, {
    type: "dm.message",
    data: dmMessageEventData(args.dmId, record.cursor, record.message),
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
        data: { targetUrl: `/dms/${dmId}` },
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
  // Either way we re-derive the local inbox owner from (actor, dmId) — the same
  // §8.3 guard the send ingest applies — apply to the stored copy (edit/delete
  // additionally enforcing §7.1 author-only + the edit window), and fan the
  // resulting `dm.message` / `dm.reaction` to the local recipient.
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

    const raw = (await c.req.json().catch(() => ({}))) as { actor?: unknown; content?: unknown };
    const actingActor = federationActingActor(c, raw.actor);
    const content = MessageUpdateRequestSchema.parse({ content: raw.content }).content as Content;

    const { owner, ownerActor } = resolveFederationDmOwner(db, config, actingActor, dmId);
    const row = getDmMessageRow(db, owner, dmId, messageId);
    if (!row) throw AppError.notFound({ detail: "no such message" });

    const message = applyDmEdit(db, hub, {
      owner,
      ownerActor,
      dmId,
      messageId,
      actor: actingActor,
      content,
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
  if (domainOf(actingActor) !== signer.domain) {
    throw AppError.forbidden({ detail: "a provider may only act on behalf of its own users" });
  }
  return actingActor;
}

/**
 * Resolve the LOCAL inbox owner for a forwarded DM edit/delete, applying the
 * §8.3 recipient-resolution guard: the local user `u` such that
 * `deriveDmId(actingActor, u@authority) === dmId`. No match → 400 (the message
 * is for a conversation with no local recipient — inbox poisoning). Returns both
 * the bare handle and the full `handle@authority` actor.
 */
function resolveFederationDmOwner(
  db: Db,
  config: Config,
  actingActor: string,
  dmId: string,
): { owner: string; ownerActor: string } {
  const owner = resolveLocalDmOwner(db, config, actingActor, dmId);
  if (owner === null) {
    throw AppError.badRequest({
      detail: "{dmId} does not match a conversation between the actor and a local recipient",
    });
  }
  const authority = canonicalAuthority(config.domain);
  return { owner, ownerActor: `${owner}@${authority}` };
}

/**
 * Shared handler for the federation DM-reaction ingest (add/remove). The message
 * lives in a LOCAL recipient's inbox and the reaction reaches us in either §8.3
 * delivery shape — user-signed by the reacting participant, or provider-signed
 * by their home provider (see {@link federationActingActor}). We re-derive the
 * local owner from `(actor, dmId)` — the same §8.3 guard the DM-send ingest
 * uses — store/remove, then fan out.
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

  // A DELETE may legitimately arrive with no body at all, hence the catch.
  const body = (await c.req.json().catch(() => ({}))) as { actor?: unknown };
  // User-signed → the reacting actor IS the signer and `body.actor` is ignored;
  // provider-signed → the named actor's domain must equal the signing
  // provider's domain, binding the body actor to the peer that signed the
  // request (a peer may only act on behalf of its own users), and a
  // missing/blank actor is a 400. See {@link federationActingActor}.
  const reactingActor = federationActingActor(c, body.actor);

  // §8.3 guard: the local inbox owner is the local user `u` such that
  // deriveDmId(reactingActor, u@authority) === dmId. No match → 400 (the
  // reaction is for a conversation with no local recipient — inbox poisoning).
  const owner = resolveLocalDmOwner(db, config, reactingActor, dmId);
  if (owner === null) {
    throw AppError.badRequest({
      detail: "{dmId} does not match a conversation between the actor and a local recipient",
    });
  }
  const authority = canonicalAuthority(config.domain);
  const recipientActor = `${owner}@${authority}`;

  if (!getDmMessageRow(db, owner, dmId, messageId)) {
    throw AppError.notFound({ detail: "no such message" });
  }

  if (state === "added") {
    const reaction = addDmReaction(db, { dmId, messageId, author: reactingActor, key });
    fanOutDmReaction(hub, {
      dmId,
      messageId,
      state: "added",
      author: reactingActor,
      key,
      reaction,
      participants: [recipientActor, reactingActor],
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
    participants: [recipientActor, reactingActor],
  });
  return c.body(null, 204);
}

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
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const { cursor, limit } = pageQuery(c);
    const page = listDmConversations(db, requireLocalHandle(c), {
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
  // Returns the caller's FULL conversation view the provider can serve: the
  // messages they SENT (rows authored by them, stored in the counterparty's
  // local inbox) ∪ the messages they RECEIVED (their own inbox, when local),
  // over the shared global seq cursor space (§7.4). Works same- and
  // cross-provider (a remote sender reading the recipient's provider gets their
  // sent rows by `author` scope).
  router.get("/:dmId/messages", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const viewer: DmViewer = dmViewerOf(actor);

    // Participation: the caller must own a local inbox row for dmId, OR be named
    // as the counterparty of some local inbox row for dmId (covers an only-sent /
    // cross-provider sender with no inbox here). A true non-participant → 404.
    if (!isDmThreadParticipant(db, dmId, viewer)) {
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
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const dmId = requireParam(c, "dmId");
    const messageId = requireParam(c, "messageId");
    const viewer: DmViewer = dmViewerOf(actor);

    if (!isDmThreadParticipant(db, dmId, viewer)) {
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
    const ownCounterparty = me !== undefined && own ? counterpartyOf(db, me, dmId) : null;
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
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId) : null;
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
      return c.body(await res.text(), res.status as 200 | 201 | 400 | 404);
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
    const ownCounterparty = me !== undefined && own ? counterpartyOf(db, me, dmId) : null;
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
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId) : null;
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
      return c.body(null, res.status === 204 ? 204 : (res.status as 400 | 404));
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

    const body = MessageUpdateRequestSchema.parse(await c.req.json());
    const content = body.content as Content;

    // (a) The target lives in the caller's own LOCAL inbox.
    const me = actor.localHandle;
    const own = me !== undefined ? getDmMessageRow(db, me, dmId, messageId) : null;
    if (me !== undefined && own) {
      const message = applyDmEdit(db, hub, {
        owner: me,
        ownerActor: actor.actor,
        dmId,
        messageId,
        actor: actor.actor,
        content,
        row: own,
      });
      return c.json(MessageSchema.parse(message));
    }

    // (b) The target lives in a LOCAL counterparty's inbox — the caller SENT it.
    const owner = resolveLocalDmOwner(db, config, actor.actor, dmId);
    const row = owner !== null ? getDmMessageRow(db, owner, dmId, messageId) : null;
    if (owner !== null && row) {
      const message = applyDmEdit(db, hub, {
        owner,
        ownerActor: `${owner}@${authority}`,
        dmId,
        messageId,
        actor: actor.actor,
        content,
        row,
      });
      return c.json(MessageSchema.parse(message));
    }

    // (c) The counterparty is REMOTE → the message lives on their provider.
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId) : null;
    const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
    if (cpDomain !== "" && cpDomain !== authority) {
      const res = await forwardDmEdit(db, config, federationFetch, {
        dmId,
        messageId,
        counterpartyDomain: cpDomain,
        actor: actor.actor,
        content,
      });
      return c.body(await res.text(), res.status as 200 | 400 | 403 | 404);
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
    const counterparty = me !== undefined ? counterpartyOf(db, me, dmId) : null;
    const cpDomain = counterparty !== null ? domainOf(counterparty) : "";
    if (cpDomain !== "" && cpDomain !== authority) {
      const res = await forwardDmDelete(db, config, federationFetch, {
        dmId,
        messageId,
        counterpartyDomain: cpDomain,
        actor: actor.actor,
      });
      if (res.status === 204) return c.body(null, 204);
      return c.body(await res.text(), res.status as 400 | 403 | 404);
    }

    // (d) Not stored here.
    throw AppError.notFound({ detail: "no such message" });
  });

  return router;
}
