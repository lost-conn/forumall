/**
 * Request-side helpers shared by the DM routers (§7.4, §8.3): path params,
 * local inbox-owner resolution, viewer scoping and reaction-key
 * validation.
 */
import { canonicalActor, canonicalAuthority, deriveDmId } from "@forumall/shared";
import type { Context } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { type DmViewer, getDmConversationRow } from "../provider/dms.ts";
import { AppError } from "./errors.ts";
import type { AppBindings, AuthenticatedActor } from "./types.ts";

/** Max length of a reaction key (matches the channel reaction key bound). */
const MAX_REACTION_KEY_LENGTH = 64;

/** Read a path param guaranteed present by the mounted route. */
export function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * Resolve the LOCAL inbox owner for a `(author, dmId)` pair — the local user
 * `u` whose derived dmId with `author` equals `dmId` (§8.3 recipient
 * resolution, O(n) over local users). Returns the bare local handle, or `null`
 * if no local user is the recipient (i.e. the inbox lives on a remote provider).
 */
export function resolveLocalDmOwner(
  db: Db,
  config: Config,
  author: string,
  dmId: string,
): string | null {
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
export function counterpartyOf(db: Db, owner: string, dmId: string, domain: string): string | null {
  // An inconsistent pointer (§7.4) resolves to `null`, so it never triggers a
  // forward or a fan-out. Served in canonical form.
  const row = getDmConversationRow(db, owner, dmId, domain);
  return row ? canonicalActor(row.counterparty) : null;
}

/**
 * The {@link DmViewer} for an authenticated caller. A LOCAL caller sees both what
 * they authored and their own inbox; a REMOTE caller (§4.6) — legitimately
 * reading/mutating a thread on the recipient's provider (§8.3) — is scoped to the
 * rows they AUTHORED, never to a local inbox that merely shares their handle.
 */
export function dmViewerOf(actor: AuthenticatedActor): DmViewer {
  return {
    actor: actor.actor,
    ...(actor.localHandle !== undefined ? { localHandle: actor.localHandle } : {}),
  };
}

/** The host (domain) part of `handle@domain`, canonicalized; "" if malformed. */
export function domainOf(actor: string): string {
  const at = actor.lastIndexOf("@");
  if (at <= 0 || at === actor.length - 1) return "";
  return canonicalAuthority(actor.slice(at + 1));
}

/** Reject an empty / over-long reaction key with a clean 400 (mirrors channels). */
export function assertValidReactionKey(key: string): void {
  if (key.length === 0 || key.length > MAX_REACTION_KEY_LENGTH) {
    throw AppError.badRequest({ detail: "invalid reaction key" });
  }
}
