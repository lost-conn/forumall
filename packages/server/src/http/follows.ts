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
 * foreign host is a remote channel.
 *
 * ## Access check on follow (§7.6)
 * The provider SHOULD verify the caller currently has access before recording the
 * pointer:
 *  - **Local** channel → resolve the channel row, then gate via
 *    {@link channelVisibleTo} (tier + group membership). Not visible → **403**;
 *    no such local channel → **404**.
 *  - **Remote** channel → real access verification requires federation (P7), so
 *    the pointer is stored WITHOUT a remote access check for now. P7 can add a
 *    remote access check here (fetch the remote channel / attempt a read against
 *    its home provider) before recording the follow.
 *
 * Following is idempotent (an already-followed channel returns the existing
 * `Follow` with 200; a new follow returns 201). Unfollow is idempotent too: a
 * delete always returns **204**, whether or not a row existed.
 */
import {
  FollowCreateRequestSchema,
  FollowsResponseSchema,
  canonicalAuthority,
} from "@forumall/shared";
import { type Context, Hono } from "hono";

import { channelVisibleTo, getChannelRow } from "../provider/channels.ts";
import { addFollow, listFollows, removeFollow } from "../provider/follows.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * Classify a channel ref (§2.4). A bare `chn_…` id, or a URI whose host is this
 * provider's domain, is LOCAL → return its local channel id. A URI with a
 * foreign host is REMOTE → `{ kind: "remote" }`. Anything else (a non-`chn_`
 * non-URI string, or a local URI not shaped like a channel URL) is treated as a
 * malformed/unknown local ref → `{ kind: "local", channelId: null }`.
 */
function classifyChannelRef(
  c: Context<AppBindings>,
  ref: string,
): { kind: "local"; channelId: string | null } | { kind: "remote" } {
  const { config } = c.var;
  const host = canonicalAuthority(config.domain);

  if (ref.startsWith("https://") || ref.startsWith("http://")) {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return { kind: "local", channelId: null };
    }
    if (canonicalAuthority(url.host) !== host) return { kind: "remote" };
    // Local URI: pull the channel id out of the canonical channel path, e.g.
    // https://{domain}/api/groups/{groupId}/channels/{channelId}
    const m = url.pathname.match(/\/channels\/([^/]+)\/?$/);
    return { kind: "local", channelId: m ? decodeURIComponent(m[1] as string) : null };
  }

  // Bare ref — a local channel id (e.g. `chn_…`).
  return { kind: "local", channelId: ref };
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
  // The caller's follow list — pointers only. Validated against the shared
  // FollowsResponseSchema.
  router.get("/", signed, local, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const items = listFollows(db, requireLocalHandle(c));
    return c.json(FollowsResponseSchema.parse({ follows: items, metadata: [] }), 200);
  });

  // -- POST /follows (§7.6 — signed) --------------------------------------
  // Start following a channel. Access check before storing the pointer:
  // local channel → channelVisibleTo (403 if not visible, 404 if no such
  // channel); remote channel → stored without a remote access check (P7).
  // Idempotent: already-followed → existing Follow (200); new → 201.
  router.post("/", signed, local, async (c) => {
    const { db } = c.var;
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
    const groupId = parsed.data.groupId ?? null;
    const classified = classifyChannelRef(c, channel);

    if (classified.kind === "local") {
      // Local channel: verify the caller currently has access (§7.6). 404 if no
      // such local channel; 403 if it exists but is not visible to the caller.
      if (classified.channelId === null) {
        throw AppError.notFound({ detail: "no such local channel" });
      }
      const row = getChannelRow(db, classified.channelId);
      if (!row) throw AppError.notFound({ detail: "no such local channel" });
      if (!channelVisibleTo(db, row.groupId, row.tier, actor.actor)) {
        throw AppError.forbidden({ detail: "you do not have access to this channel" });
      }
    }
    // else: remote channel (foreign-host URI). Real access verification requires
    // federation (P7) — store the pointer without a remote access check for now.
    // P7 can add a remote access check here before recording the follow.

    const { follow, created } = addFollow(db, requireLocalHandle(c), channel, groupId);
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
