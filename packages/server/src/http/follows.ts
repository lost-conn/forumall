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
 * ## Channel refs: local vs. remote (§2.2, §7.6)
 * `channel` (and `{channelRef}`) is a ref: a bare local `chn_…` id, or an HTTPS
 * object URI with no query or fragment — anything else, or a URI whose authority
 * is not canonical, is `400`. A URI whose authority is THIS provider's names a
 * local channel and is treated exactly like its local id: it is stored, matched
 * and removed as the bare id, so an id and its own URI are one follow. A URI
 * with a foreign authority is a remote channel ({@link classifyChannelRef},
 * {@link followKey}).
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
 * delete of a valid ref always returns **204**, whether or not a row existed.
 */
import { FollowCreateRequestSchema, FollowsResponseSchema } from "@forumall/shared";
import { type Context, Hono } from "hono";

import { getReadableChannel } from "../provider/channels.ts";
import { isProviderAllowed } from "../provider/federation/policy.ts";
import {
  type ChannelRefTarget,
  addFollow,
  classifyChannelRef,
  followKey,
  listFollows,
  removeFollow,
} from "../provider/follows.ts";
import { assertCanonicalUriAuthority } from "./canonical-fields.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * Classify a channel ref from the request (§2.2), rejecting with `400` one that
 * is neither a local id nor an HTTPS object URI without query or fragment, and
 * an object URI whose authority is not in canonical form (`EVIL.example:443`,
 * `a.test:0443`, `x@a.test`), so every stored pointer has one spelling.
 */
function resolveChannelRef(
  domain: string,
  ref: string,
): Exclude<ChannelRefTarget, { kind: "invalid" }> {
  const target = classifyChannelRef(domain, ref);
  if (target.kind === "invalid") throw AppError.badRequest({ detail: target.reason });
  if (ref.startsWith("https://")) assertCanonicalUriAuthority(ref, "channel");
  return target;
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

    const target = resolveChannelRef(config.domain, parsed.data.channel);

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
    } else if (!isProviderAllowed(config, target.authority)) {
      // §8: the remote host (canonical, checked above) must be allowed.
      throw AppError.forbidden({ detail: "federation with that provider is not allowed" });
    }

    const key = followKey(db, target);
    if (key === null) throw AppError.notFound({ detail: "no such local channel" });
    const { follow, created } = addFollow(db, config.domain, requireLocalHandle(c), key);
    return c.json(follow, created ? 201 : 200);
  });

  // -- DELETE /follows/{channelRef} (§7.6 — signed) -----------------------
  // Stop following. Idempotent: 204 for any valid ref, whether or not a row
  // existed (a malformed ref is 400, as on follow).
  router.delete("/:channelRef", signed, local, (c) => {
    const { db, config } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const ref = decodeURIComponent(requireParam(c, "channelRef"));
    const key = followKey(db, resolveChannelRef(config.domain, ref));
    if (key !== null) removeFollow(db, requireLocalHandle(c), key);
    return c.body(null, 204);
  });

  return router;
}
