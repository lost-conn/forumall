/**
 * Follows router (spec §7.6). Mounted at `/api/me/follows`.
 *
 * A follow is a **pointer**, not a copy: this provider stores only *which*
 * channels the caller follows and MUST NOT compile or store a feed (the client
 * composes the home feed by reading each followed channel from its authoritative
 * source, §7.6). There is therefore NO feed-compilation endpoint here, and the
 * optional convenience fan-out endpoint mentioned in §7.6 is deliberately out of
 * scope (it would store nothing, so it is simply not implemented).
 *
 * ## Channel refs: local vs. remote (§2.4, §7.6)
 * `channel` is a channel reference: a bare local `chn_…` id, or a URI. A URI
 * whose host is THIS provider's domain resolves to a local channel; a URI with a
 * foreign host is a remote channel ({@link classifyChannelRef}).
 *
 * ## `groupId` (§7.6)
 * A `groupId` in the request body is ignored: the `Follow`'s `groupId` is
 * derived from the channel (`deriveFollowGroupId`, `provider/follows.ts`) — the local channel's
 * group id, or the group's object URI on a remote channel's authority.
 *
 * ## Access check on follow (§7.6)
 * The provider SHOULD verify the caller currently has access before recording the
 * pointer:
 *  - **Local** channel → resolve it through the §11.3 read gate
 *    ({@link getReadableChannel}: group tier + channel tier + any per-channel
 *    `view` override). A channel that is missing, that the caller cannot read,
 *    or that a local channel URI places in a group it is not in → the same
 *    **404** ("hidden channels answer as missing").
 *  - **Remote** channel → the remote host must be allowed (§8); the pointer is
 *    then stored without fetching the remote channel.
 *
 * Following is idempotent (an already-followed channel returns the existing
 * `Follow` with 200; a new follow returns 201). Unfollow is idempotent too: a
 * delete always returns **204**, whether or not a row existed.
 */
import { FollowCreateRequestSchema, FollowsResponseSchema } from "@forumall/shared";
import { type Context, Hono } from "hono";

import { getReadableChannel } from "../provider/channels.ts";
import { isProviderAllowed } from "../provider/federation/policy.ts";
import { addFollow, classifyChannelRef, listFollows, removeFollow } from "../provider/follows.ts";
import { assertCanonicalUriAuthority } from "./canonical-fields.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * The caller-facing follows router: `GET /follows`, `POST /follows`,
 * `DELETE /follows/{channelRef}`. Mounted at `/api/me/follows`.
 */
export function createMeFollowsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  // Follows are provider-local rows keyed on the caller's own handle (§7.6).
  const local = requireLocalActor();

  // -- GET /follows (§7.6 — signed) ---------------------------------------
  // The caller's follow list — pointers only, each `groupId` derived from its
  // channel. Validated against the shared FollowsResponseSchema.
  router.get("/", signed, local, (c) => {
    const { db, config } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const items = listFollows(db, config.domain, requireLocalHandle(c));
    return c.json(FollowsResponseSchema.parse({ follows: items, metadata: [] }), 200);
  });

  // -- POST /follows (§7.6 — signed) --------------------------------------
  // Start following a channel. Access check before storing the pointer:
  // local channel → the §11.3 read gate (404 if missing or unreadable);
  // remote channel → the §8 federation policy. The body's `groupId` is
  // ignored (derived from the channel). Idempotent: already-followed →
  // existing Follow (200); new → 201.
  router.post("/", signed, local, async (c) => {
    const { db, config } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = FollowCreateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid follow create request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const channel = parsed.data.channel;
    // §2.2: an object URI must name its provider canonically — local or remote —
    // so the stored pointer has one spelling (`EVIL.example:443`,
    // `a.test:0443`, `x@a.test` → 400).
    const uriHost =
      channel.startsWith("https://") || channel.startsWith("http://")
        ? assertCanonicalUriAuthority(channel, "channel")
        : null;
    const target = classifyChannelRef(config.domain, channel);

    if (target.kind === "local") {
      // Local channel: verify the caller currently has access (§7.6). A
      // missing channel, one the caller cannot read, and one a local URI
      // places in another group all get the same 404 (§11.3).
      if (
        target.channelId === null ||
        !getReadableChannel(db, target.channelId, actor.actor, target.pathGroupId ?? undefined)
      ) {
        throw AppError.notFound({ detail: "no such local channel" });
      }
    } else if (uriHost === null || !isProviderAllowed(config, uriHost)) {
      // §8: the remote host (canonical, checked above) must be allowed.
      throw AppError.forbidden({ detail: "federation with that provider is not allowed" });
    }

    const { follow, created } = addFollow(db, config.domain, requireLocalHandle(c), channel);
    return c.json(follow, created ? 201 : 200);
  });

  // -- DELETE /follows/{channelRef} (§7.6 — signed) -----------------------
  // Stop following. Idempotent: always 204, whether or not a row existed.
  router.delete("/:channelRef", signed, local, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const channel = decodeURIComponent(requireParam(c, "channelRef"));
    removeFollow(db, requireLocalHandle(c), channel);
    return c.body(null, 204);
  });

  return router;
}
