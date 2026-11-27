/**
 * Direct-message routers (spec §7.4, §8.3) — the map of where each part lives.
 *
 *  - `POST /api/federation/dms/{dmId}/messages` — the single DM send path
 *    (user-signed), plus the federation edit/delete/reaction ingest:
 *    `dms-federation.ts`. The recipient's home provider stores the message in
 *    the LOCAL recipient's inbox and emits `dm.message`. NO sender copy (§8.3).
 *  - `GET /api/me/dms` (conversation list) and `PUT /api/me/dms/{dmId}`
 *    (conversation pointer): `dm-conversation-routes.ts`.
 *  - `GET /api/dms/{dmId}/messages` and `…/{messageId}/replies` — paged
 *    history: the caller's FULL conversation view (what they received ∪ what
 *    they sent), participant-only (§7.4): this module.
 *  - `PUT`/`DELETE /api/dms/{dmId}/messages/{messageId}/reactions/{key}`:
 *    `dm-reaction-routes.ts`.
 *  - `PATCH`/`DELETE /api/dms/{dmId}/messages/{messageId}`:
 *    `dm-edit-routes.ts`.
 *  - Real-time fan-out (`dm.message`, `dm.reaction`, `dm.conversation`):
 *    `dm-events.ts`; `dmId` WS subscriptions and their `since` resume:
 *    `ws/subscriptions.ts` + `ws/dm-subscriptions.ts`.
 *
 * Shared request helpers are in `dm-request.ts`, peer forwarding in
 * `dm-forwarding.ts`.
 *
 * ## Non-participants
 * A caller who is not a participant of an existing conversation gets exactly
 * the answer an unknown `dmId` gets on every DM path: `404` over REST,
 * `not_found` on a WS subscribe — so a third party cannot learn that two other
 * users talk.
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
import { MessagesPageSchema, canonicalAuthority } from "@forumall/shared";
import { Hono } from "hono";
import { listDmMessages } from "../provider/dm-history.ts";
import { listDmReplies, withDmReactions } from "../provider/dm-reactions.ts";
import { type DmViewer, isDmThreadParticipant } from "../provider/dms.ts";
import { registerDmEditRoutes } from "./dm-edit-routes.ts";
import { registerDmReactionRoutes } from "./dm-reaction-routes.ts";
import { dmViewerOf, pageQuery, requireParam } from "./dm-request.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * The `/api/dms/{dmId}/messages` router (read, react, edit/delete). Mounted at
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

  registerDmReactionRoutes(router);
  registerDmEditRoutes(router);
  return router;
}
