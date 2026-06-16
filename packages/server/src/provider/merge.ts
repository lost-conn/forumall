/**
 * Guest → EXISTING-account "merge" (Forumall extension over §4.8 / §4.1).
 *
 * The companion of the guest CLAIM (`provider/claim.ts`). Where claim renames a
 * guest into a brand-NEW, guaranteed-free handle, MERGE folds a guest's content
 * and identity into a PRE-EXISTING full account: a signed-in guest supplies that
 * account's handle + password (a login-equivalent credential check), and every
 * identity reference the guest holds is re-pointed at the target actor, the
 * guest's CURRENT device key(s) are re-bound to the target (so this device stays
 * logged in — now as the target), and finally the guest's `users` row is deleted.
 *
 * Because the target already exists, EVERY rewrite can collide with one of the
 * target's own rows, so — unlike claim — each table needs a conflict policy. The
 * confirmed policy (see the per-table notes inline) is roughly:
 *
 *  - device_keys           : RE-BIND to target (target gains the guest's device).
 *  - group_members         : role conflict → KEEP TARGET'S role (drop guest's);
 *                            else re-point (target joins with the guest's role).
 *  - privacy_settings,
 *    presence              : TARGET WINS (drop the guest's singleton row).
 *  - read_markers          : per channel keep MAX(guest, target) seq.
 *  - groups.owner,
 *    messages.author,
 *    media.owner,
 *    invites.created_by,
 *    notification_endpoints,
 *    push_subscriptions     : pure TRANSFER (re-point; no unique tuple to clash).
 *  - reactions,
 *    notifications,
 *    notification_preferences,
 *    contacts (both sides),
 *    follows,
 *    join_requests          : DEDUPE-then-transfer (drop guest's row when the
 *                             target already has the unique tuple, else re-point).
 *  - dm_messages,
 *    dm_conversations,
 *    dm_reactions           : re-key to the target actor + recompute `dm_id`,
 *                             merging into the target's threads (conversations
 *                             coalesce to one row per (owner, dm_id); reactions
 *                             dedupe on their unique tuple).
 *
 * The target's OWN attributes (`is_admin`, password, display name, avatar, bio,
 * privacy) are NEVER touched — a merge only MOVES the guest's data in. All of the
 * above runs inside a single `db.sqlite.transaction(...)`.
 */
import { canonicalAuthority, deriveDmId } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import {
  type UserRow,
  bootstrapTokens,
  contacts,
  deviceKeys,
  dmConversations,
  dmMessages,
  dmReactions,
  follows,
  groupMembers,
  groups,
  invites,
  joinRequests,
  media,
  messages,
  notificationEndpoints,
  notificationPreferences,
  notifications,
  presence,
  privacySettings,
  pushSubscriptions,
  reactions,
  readMarkers,
  users,
} from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { hashPassword, verifyPassword } from "./password.ts";

/**
 * A precomputed Argon2id hash of a throwaway password, used as the verify target
 * on the unknown/passwordless-target path so the credential check costs (and
 * thus times) the same as a real one. Mirrors `http/auth.ts`'s dummy verify.
 */
let dummyHashCache: { hash: string; key: string } | null = null;
function dummyHash(params: { memoryKib: number; iterations: number; parallelism: number }): string {
  const key = `${params.memoryKib}:${params.iterations}:${params.parallelism}`;
  if (!dummyHashCache || dummyHashCache.key !== key) {
    dummyHashCache = { hash: hashPassword(" dummy-merge-target", params), key };
  }
  return dummyHashCache.hash;
}

/** Input to {@link mergeGuestIntoAccount}. */
export interface MergeGuestInput {
  /** The EXISTING full account's bare handle the guest is merging into. */
  readonly targetHandle: string;
  /** The target account's plaintext password (login-equivalent check). */
  readonly password: string;
}

/** Result of a successful {@link mergeGuestIntoAccount}. */
export interface MergeGuestResult {
  /** The target's canonical actor (`targetHandle@<domain>`). */
  readonly actor: string;
  /** The target's bare handle. */
  readonly handle: string;
}

/**
 * Fold the guest account `guestHandle` into the EXISTING full account named
 * `input.targetHandle` after a login-equivalent password check. Re-points every
 * identity reference the guest holds at the target actor, resolving every
 * uniqueness collision per the module-header policy, re-binds the guest's device
 * key(s) to the target, and deletes the guest's `users` row + bootstrap tokens.
 *
 * Validation (in order):
 *  - the caller row must exist (`AppError.notFound`) and be a guest
 *    (`AppError.conflict` "account is already a full account");
 *  - the target must resolve (case-insensitively, as login does) to a row WITH a
 *    non-null password hash AND the password must verify — otherwise a uniform
 *    `AppError.unauthorized` ("invalid handle or password") after a dummy verify
 *    that equalizes timing (no target enumeration; a passwordless guest can never
 *    be a merge target);
 *  - the target must not be the caller itself (`AppError.conflict`).
 *
 * @param guestHandle the caller's (guest's) current bare handle.
 */
export function mergeGuestIntoAccount(
  db: Db,
  config: Config,
  guestHandle: string,
  input: MergeGuestInput,
): MergeGuestResult {
  const domain = canonicalAuthority(config.domain);

  // -- Caller must be an existing guest ------------------------------------
  const guestRow = db.drizzle
    .select()
    .from(users)
    .where(eq(users.handle, guestHandle))
    .limit(1)
    .all()[0] as UserRow | undefined;
  if (!guestRow) throw AppError.notFound({ detail: "no such user" });
  if (!guestRow.guest) {
    throw AppError.conflict({ detail: "account is already a full account" });
  }

  // -- Resolve the target (case-insensitive, as login does) ----------------
  const targetRow = db.drizzle
    .select()
    .from(users)
    .where(eq(users.handle, input.targetHandle))
    .limit(1)
    .all()[0] as UserRow | undefined;

  // Always run a verify so the unknown-handle, passwordless-target, and
  // wrong-password paths cost the same and produce a byte-identical 401 (no
  // target enumeration). A guest target has no password hash → never a valid
  // merge destination; treat a null hash like an unknown handle (dummy verify).
  let ok = false;
  if (targetRow?.passwordHash != null) {
    ok = verifyPassword(input.password, targetRow.passwordHash);
  } else {
    verifyPassword(input.password, dummyHash(config.argon2));
  }
  if (!ok || !targetRow) {
    throw AppError.unauthorized({ detail: "invalid handle or password" });
  }

  // Defensive: a guest's handle is `guest_…` and the target has a password, so
  // they can never be equal — but guard the degenerate "merge into self" anyway.
  if (targetRow.handle === guestHandle) {
    throw AppError.conflict({ detail: "cannot merge an account into itself" });
  }

  const targetHandle = targetRow.handle;
  const guestActor = `${guestHandle}@${domain}`;
  const targetActor = `${targetHandle}@${domain}`;

  db.sqlite.transaction(() => {
    mergeDeviceKeys(db, guestHandle, targetHandle);
    mergeGroupMembers(db, guestActor, targetActor);
    mergeSingletonState(db, guestHandle);
    mergeReadMarkers(db, guestHandle, targetHandle);
    mergeTransferredColumns(db, guestHandle, guestActor, targetHandle, targetActor);
    mergeReactions(db, guestActor, targetActor);
    mergeNotifications(db, guestHandle, targetHandle);
    mergeNotificationPreferences(db, guestHandle, targetHandle);
    mergeContacts(db, guestHandle, guestActor, targetHandle, targetActor);
    mergeFollows(db, guestHandle, targetHandle);
    mergeJoinRequests(db, guestActor, targetActor);

    // DM re-keying + thread merge (recompute dm_id from the target actor).
    mergeDmMessages(db, guestHandle, guestActor, targetHandle, targetActor);
    mergeDmConversations(db, guestHandle, guestActor, targetHandle, targetActor);
    mergeDmReactions(db, guestActor, targetActor);

    // Finally: the guest is fully merged in; drop its row + ephemeral tokens.
    db.drizzle.delete(bootstrapTokens).where(eq(bootstrapTokens.handle, guestHandle)).run();
    db.drizzle.delete(users).where(eq(users.handle, guestHandle)).run();
  })();

  return { actor: targetActor, handle: targetHandle };
}

// ===========================================================================
// Per-table merge helpers
// ===========================================================================

/**
 * device_keys: RE-BIND the guest's device key(s) to the target. The keyId +
 * keypair are unchanged; the same private key now signs as the target. Key ids
 * are globally unique so there is no collision (the target simply gains a device).
 */
function mergeDeviceKeys(db: Db, guestHandle: string, targetHandle: string): void {
  db.drizzle
    .update(deviceKeys)
    .set({ userHandle: targetHandle })
    .where(eq(deviceKeys.userHandle, guestHandle))
    .run();
}

/**
 * group_members: for each group the guest belongs to, if the target is ALREADY a
 * member, DROP the guest's row (target keeps its existing role); otherwise
 * re-point the guest's row to the target actor (target joins with the guest's
 * role). The PK is (group_id, user).
 */
function mergeGroupMembers(db: Db, guestActor: string, targetActor: string): void {
  const guestMemberships = db.drizzle
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.user, guestActor))
    .all();
  for (const m of guestMemberships) {
    const targetAlready = db.drizzle
      .select({ user: groupMembers.user })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, m.groupId), eq(groupMembers.user, targetActor)))
      .limit(1)
      .all()[0];
    if (targetAlready) {
      // Role conflict → keep target's role, drop the guest's membership.
      db.drizzle
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, m.groupId), eq(groupMembers.user, guestActor)))
        .run();
    } else {
      db.drizzle
        .update(groupMembers)
        .set({ user: targetActor })
        .where(and(eq(groupMembers.groupId, m.groupId), eq(groupMembers.user, guestActor)))
        .run();
    }
  }
}

/**
 * Singleton owned state (privacy_settings, presence): TARGET WINS. The target's
 * own settings/presence are authoritative; simply DROP the guest's rows. (Both
 * are keyed by `handle`, so re-pointing would collide with the target's row.)
 */
function mergeSingletonState(db: Db, guestHandle: string): void {
  db.drizzle.delete(privacySettings).where(eq(privacySettings.handle, guestHandle)).run();
  db.drizzle.delete(presence).where(eq(presence.handle, guestHandle)).run();
}

/**
 * read_markers: per (handle, scopeId) keep the HIGHER `lastReadSeq`. If the
 * target already has a marker for that scope, bump it to max(guest, target) and
 * drop the guest's row; otherwise re-point the guest's row to the target. PK is
 * (handle, scopeId).
 */
function mergeReadMarkers(db: Db, guestHandle: string, targetHandle: string): void {
  const guestMarkers = db.drizzle
    .select()
    .from(readMarkers)
    .where(eq(readMarkers.handle, guestHandle))
    .all();
  for (const gm of guestMarkers) {
    const targetMarker = db.drizzle
      .select()
      .from(readMarkers)
      .where(and(eq(readMarkers.handle, targetHandle), eq(readMarkers.scopeId, gm.scopeId)))
      .limit(1)
      .all()[0];
    if (targetMarker) {
      if (gm.lastReadSeq > targetMarker.lastReadSeq) {
        db.drizzle
          .update(readMarkers)
          .set({ lastReadSeq: gm.lastReadSeq, updatedAt: Date.now() })
          .where(and(eq(readMarkers.handle, targetHandle), eq(readMarkers.scopeId, gm.scopeId)))
          .run();
      }
      db.drizzle
        .delete(readMarkers)
        .where(and(eq(readMarkers.handle, guestHandle), eq(readMarkers.scopeId, gm.scopeId)))
        .run();
    } else {
      db.drizzle
        .update(readMarkers)
        .set({ handle: targetHandle })
        .where(and(eq(readMarkers.handle, guestHandle), eq(readMarkers.scopeId, gm.scopeId)))
        .run();
    }
  }
}

/**
 * Pure transfers (no unique tuple to clash with the target): re-point the
 * guest's references to the target. Bare-handle columns → targetHandle; full
 * actor columns → targetActor.
 */
function mergeTransferredColumns(
  db: Db,
  guestHandle: string,
  guestActor: string,
  targetHandle: string,
  targetActor: string,
): void {
  // Full-actor columns.
  db.drizzle.update(groups).set({ owner: targetActor }).where(eq(groups.owner, guestActor)).run();
  db.drizzle
    .update(messages)
    .set({ author: targetActor })
    .where(eq(messages.author, guestActor))
    .run();
  db.drizzle.update(media).set({ owner: targetActor }).where(eq(media.owner, guestActor)).run();
  db.drizzle
    .update(invites)
    .set({ createdBy: targetActor })
    .where(eq(invites.createdBy, guestActor))
    .run();

  // Bare-handle columns.
  db.drizzle
    .update(notificationEndpoints)
    .set({ owner: targetHandle })
    .where(eq(notificationEndpoints.owner, guestHandle))
    .run();
  db.drizzle
    .update(pushSubscriptions)
    .set({ recipient: targetHandle })
    .where(eq(pushSubscriptions.recipient, guestHandle))
    .run();
}

/**
 * reactions: dedupe-then-transfer on the unique (message_id, author, key) tuple.
 * If the target already reacted to the same message with the same key, drop the
 * guest's row; otherwise re-point its author to the target.
 */
function mergeReactions(db: Db, guestActor: string, targetActor: string): void {
  const guestReactions = db.drizzle
    .select()
    .from(reactions)
    .where(eq(reactions.author, guestActor))
    .all();
  for (const r of guestReactions) {
    const dup = db.drizzle
      .select({ id: reactions.id })
      .from(reactions)
      .where(
        and(
          eq(reactions.messageId, r.messageId),
          eq(reactions.author, targetActor),
          eq(reactions.key, r.key),
        ),
      )
      .limit(1)
      .all()[0];
    if (dup) {
      db.drizzle.delete(reactions).where(eq(reactions.id, r.id)).run();
    } else {
      db.drizzle.update(reactions).set({ author: targetActor }).where(eq(reactions.id, r.id)).run();
    }
  }
}

/**
 * notifications: dedupe-then-transfer on the unique
 * (recipient, type, source_message_id) tuple.
 */
function mergeNotifications(db: Db, guestHandle: string, targetHandle: string): void {
  const guestNotifs = db.drizzle
    .select()
    .from(notifications)
    .where(eq(notifications.recipient, guestHandle))
    .all();
  for (const n of guestNotifs) {
    const dup = db.drizzle
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipient, targetHandle),
          eq(notifications.type, n.type),
          eq(notifications.sourceMessageId, n.sourceMessageId),
        ),
      )
      .limit(1)
      .all()[0];
    if (dup) {
      db.drizzle.delete(notifications).where(eq(notifications.id, n.id)).run();
    } else {
      db.drizzle
        .update(notifications)
        .set({ recipient: targetHandle })
        .where(eq(notifications.id, n.id))
        .run();
    }
  }
}

/**
 * notification_preferences: dedupe-then-transfer on the unique
 * (owner, scope_type, scope_id) tuple. The target's preference wins on a clash.
 */
function mergeNotificationPreferences(db: Db, guestHandle: string, targetHandle: string): void {
  const guestPrefs = db.drizzle
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.owner, guestHandle))
    .all();
  for (const p of guestPrefs) {
    const dup = db.drizzle
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.owner, targetHandle),
          eq(notificationPreferences.scopeType, p.scopeType),
          eq(notificationPreferences.scopeId, p.scopeId),
        ),
      )
      .limit(1)
      .all()[0];
    if (dup) {
      db.drizzle.delete(notificationPreferences).where(eq(notificationPreferences.id, p.id)).run();
    } else {
      db.drizzle
        .update(notificationPreferences)
        .set({ owner: targetHandle })
        .where(eq(notificationPreferences.id, p.id))
        .run();
    }
  }
}

/**
 * contacts: BOTH directions, dedupe-then-transfer on the PK (owner, user).
 *
 *  - the guest's OWN outgoing rows (`owner = guestHandle`): re-point `owner` to
 *    targetHandle unless the target already has a row for that `user`; drop on
 *    clash. (A row where the guest contacts the target itself, `user =
 *    targetActor`, would create a self-contact — drop it.)
 *  - OTHERS' rows pointing AT the guest (`user = guestActor`): re-point `user`
 *    to targetActor unless that owner already has a row for the target; drop on
 *    clash. (The target's own row pointing at the guest becomes a self-contact —
 *    drop it.)
 */
function mergeContacts(
  db: Db,
  guestHandle: string,
  guestActor: string,
  targetHandle: string,
  targetActor: string,
): void {
  // Guest's outgoing rows.
  const outgoing = db.drizzle.select().from(contacts).where(eq(contacts.owner, guestHandle)).all();
  for (const c of outgoing) {
    // A guest→target row would become target→target (self-contact): drop it.
    const wouldSelf = c.user === targetActor;
    const dup =
      !wouldSelf &&
      db.drizzle
        .select({ owner: contacts.owner })
        .from(contacts)
        .where(and(eq(contacts.owner, targetHandle), eq(contacts.user, c.user)))
        .limit(1)
        .all()[0];
    if (wouldSelf || dup) {
      db.drizzle
        .delete(contacts)
        .where(and(eq(contacts.owner, guestHandle), eq(contacts.user, c.user)))
        .run();
    } else {
      db.drizzle
        .update(contacts)
        .set({ owner: targetHandle })
        .where(and(eq(contacts.owner, guestHandle), eq(contacts.user, c.user)))
        .run();
    }
  }

  // Others' rows pointing AT the guest.
  const incoming = db.drizzle.select().from(contacts).where(eq(contacts.user, guestActor)).all();
  for (const c of incoming) {
    // The target's own row pointing at the guest would become a self-contact.
    const wouldSelf = c.owner === targetHandle;
    const dup =
      !wouldSelf &&
      db.drizzle
        .select({ owner: contacts.owner })
        .from(contacts)
        .where(and(eq(contacts.owner, c.owner), eq(contacts.user, targetActor)))
        .limit(1)
        .all()[0];
    if (wouldSelf || dup) {
      db.drizzle
        .delete(contacts)
        .where(and(eq(contacts.owner, c.owner), eq(contacts.user, guestActor)))
        .run();
    } else {
      db.drizzle
        .update(contacts)
        .set({ user: targetActor })
        .where(and(eq(contacts.owner, c.owner), eq(contacts.user, guestActor)))
        .run();
    }
  }
}

/**
 * follows: dedupe-then-transfer on the PK (owner, channel). If the target already
 * follows that channel, drop the guest's row; else re-point `owner`.
 */
function mergeFollows(db: Db, guestHandle: string, targetHandle: string): void {
  const guestFollows = db.drizzle
    .select()
    .from(follows)
    .where(eq(follows.owner, guestHandle))
    .all();
  for (const f of guestFollows) {
    const dup = db.drizzle
      .select({ owner: follows.owner })
      .from(follows)
      .where(and(eq(follows.owner, targetHandle), eq(follows.channel, f.channel)))
      .limit(1)
      .all()[0];
    if (dup) {
      db.drizzle
        .delete(follows)
        .where(and(eq(follows.owner, guestHandle), eq(follows.channel, f.channel)))
        .run();
    } else {
      db.drizzle
        .update(follows)
        .set({ owner: targetHandle })
        .where(and(eq(follows.owner, guestHandle), eq(follows.channel, f.channel)))
        .run();
    }
  }
}

/**
 * join_requests: dedupe-then-transfer. The membership card keeps at most one
 * pending request per (group, user); if the target already has a request for the
 * same group, drop the guest's; else re-point `user`. (`id` is the PK.)
 */
function mergeJoinRequests(db: Db, guestActor: string, targetActor: string): void {
  const guestRequests = db.drizzle
    .select()
    .from(joinRequests)
    .where(eq(joinRequests.user, guestActor))
    .all();
  for (const jr of guestRequests) {
    const dup = db.drizzle
      .select({ id: joinRequests.id })
      .from(joinRequests)
      .where(and(eq(joinRequests.groupId, jr.groupId), eq(joinRequests.user, targetActor)))
      .limit(1)
      .all()[0];
    if (dup) {
      db.drizzle.delete(joinRequests).where(eq(joinRequests.id, jr.id)).run();
    } else {
      db.drizzle
        .update(joinRequests)
        .set({ user: targetActor })
        .where(eq(joinRequests.id, jr.id))
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// DM re-keying + thread merge
// ---------------------------------------------------------------------------

/**
 * dm_messages: re-key every row the guest authored or received into the target's
 * threads, recomputing `dm_id` from the (counterparty, targetActor) pair. Each
 * message has a globally-unique `id`, so re-keyed messages simply COEXIST with
 * the target's existing messages in the merged thread (no per-message collision).
 *
 *  - rows in the guest's OWN inbox (`owner = guestHandle`): the counterparty is
 *    `author`; new dm_id = deriveDmId(author, targetActor); `owner` → targetHandle.
 *    (A self-DM where author = guestActor maps to (targetActor, targetActor).)
 *  - rows the guest SENT, sitting in another recipient's inbox (`author =
 *    guestActor`): counterparty is `owner@domain`; new dm_id =
 *    deriveDmId(owner@domain, targetActor); `author` → targetActor. (Self-DM rows
 *    were already handled by the owner pass — their author is now targetActor.)
 *
 * A guest→target DM (the guest had DMed the target before merging) collapses into
 * a target self-DM thread (deriveDmId(targetActor, targetActor)); the messages
 * land in the target's inbox and coexist there.
 */
function mergeDmMessages(
  db: Db,
  guestHandle: string,
  guestActor: string,
  targetHandle: string,
  targetActor: string,
): void {
  const domain = targetActor.slice(targetActor.lastIndexOf("@") + 1);

  // Rows in the guest's own inbox (received, or self-DM).
  const received = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.owner, guestHandle))
    .all();
  for (const r of received) {
    const counterparty = r.author === guestActor ? targetActor : r.author;
    const newDmId = deriveDmId(counterparty, targetActor);
    db.drizzle
      .update(dmMessages)
      .set({
        owner: targetHandle,
        dmId: newDmId,
        ...(r.author === guestActor ? { author: targetActor } : {}),
      })
      .where(eq(dmMessages.id, r.id))
      .run();
  }

  // Rows the guest SENT that sit in some OTHER local recipient's inbox. (Self-DM
  // rows were re-keyed above and no longer match `author = guestActor`.)
  const stillGuestAuthor = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.author, guestActor))
    .all();
  for (const r of stillGuestAuthor) {
    const counterpartyActor = `${r.owner}@${domain}`;
    const newDmId = deriveDmId(counterpartyActor, targetActor);
    db.drizzle
      .update(dmMessages)
      .set({ author: targetActor, dmId: newDmId })
      .where(eq(dmMessages.id, r.id))
      .run();
  }
}

/**
 * dm_conversations: re-key the guest's conversation summaries into the target's,
 * recomputing `dm_id`. The PK is (owner, dm_id), so if the target already has a
 * row for the resulting (owner, dm_id), MERGE the two (keep the later
 * `updatedAt` + the greater `lastMessageSeq`) and drop the duplicate; otherwise
 * insert the re-keyed row. Delete-then-insert because both PK columns change.
 *
 *  - the guest's OWN inbox rows (`owner = guestHandle`): owner → targetHandle; a
 *    self-conversation counterparty (= guestActor) becomes targetActor; dm_id
 *    recomputed from (counterparty, targetActor).
 *  - rows in another user's inbox whose counterparty is the guest
 *    (`counterparty = guestActor`): counterparty → targetActor; dm_id recomputed
 *    from (owner@domain, targetActor).
 */
function mergeDmConversations(
  db: Db,
  guestHandle: string,
  guestActor: string,
  targetHandle: string,
  targetActor: string,
): void {
  const domain = targetActor.slice(targetActor.lastIndexOf("@") + 1);

  const owned = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, guestHandle))
    .all();
  for (const r of owned) {
    const counterparty = r.counterparty === guestActor ? targetActor : r.counterparty;
    const newDmId = deriveDmId(counterparty, targetActor);
    db.drizzle
      .delete(dmConversations)
      .where(and(eq(dmConversations.owner, r.owner), eq(dmConversations.dmId, r.dmId)))
      .run();
    upsertMergedConversation(db, {
      owner: targetHandle,
      dmId: newDmId,
      counterparty,
      updatedAt: r.updatedAt,
      lastMessageSeq: r.lastMessageSeq,
    });
  }

  const pointingAtGuest = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.counterparty, guestActor))
    .all();
  for (const r of pointingAtGuest) {
    const counterpartyActor = `${r.owner}@${domain}`;
    const newDmId = deriveDmId(counterpartyActor, targetActor);
    db.drizzle
      .delete(dmConversations)
      .where(and(eq(dmConversations.owner, r.owner), eq(dmConversations.dmId, r.dmId)))
      .run();
    upsertMergedConversation(db, {
      owner: r.owner,
      dmId: newDmId,
      counterparty: targetActor,
      updatedAt: r.updatedAt,
      lastMessageSeq: r.lastMessageSeq,
    });
  }
}

/**
 * Insert a re-keyed conversation summary, MERGING with the target's existing row
 * for (owner, dm_id) if one is present: keep the later `updatedAt` and the
 * greater `lastMessageSeq`, keeping a single row.
 */
function upsertMergedConversation(
  db: Db,
  row: {
    owner: string;
    dmId: string;
    counterparty: string;
    updatedAt: number;
    lastMessageSeq: number;
  },
): void {
  const existing = db.drizzle
    .select()
    .from(dmConversations)
    .where(and(eq(dmConversations.owner, row.owner), eq(dmConversations.dmId, row.dmId)))
    .limit(1)
    .all()[0];
  if (existing) {
    db.drizzle
      .update(dmConversations)
      .set({
        counterparty: row.counterparty,
        updatedAt: Math.max(existing.updatedAt, row.updatedAt),
        lastMessageSeq: Math.max(existing.lastMessageSeq, row.lastMessageSeq),
      })
      .where(and(eq(dmConversations.owner, row.owner), eq(dmConversations.dmId, row.dmId)))
      .run();
  } else {
    db.drizzle.insert(dmConversations).values(row).run();
  }
}

/**
 * dm_reactions: after the messages above are re-keyed, resolve each reaction's
 * new `dm_id` via its (already re-keyed) target message, re-point a guest-authored
 * reaction's `author` to the target, then dedupe on the unique
 * (dm_id, message_id, author, key) tuple (drop the guest's row on a clash).
 */
function mergeDmReactions(db: Db, guestActor: string, targetActor: string): void {
  const all = db.drizzle.select().from(dmReactions).all();
  for (const rx of all) {
    const msg = db.drizzle
      .select({ dmId: dmMessages.dmId })
      .from(dmMessages)
      .where(eq(dmMessages.id, rx.messageId))
      .limit(1)
      .all()[0];
    const newDmId = msg ? msg.dmId : rx.dmId;
    const newAuthor = rx.author === guestActor ? targetActor : rx.author;
    if (newDmId === rx.dmId && newAuthor === rx.author) continue;

    // Would the re-keyed row collide with an existing reaction tuple?
    const dup = db.drizzle
      .select({ id: dmReactions.id })
      .from(dmReactions)
      .where(
        and(
          eq(dmReactions.dmId, newDmId),
          eq(dmReactions.messageId, rx.messageId),
          eq(dmReactions.author, newAuthor),
          eq(dmReactions.key, rx.key),
        ),
      )
      .limit(1)
      .all()
      .find((d) => d.id !== rx.id);
    if (dup) {
      db.drizzle.delete(dmReactions).where(eq(dmReactions.id, rx.id)).run();
    } else {
      db.drizzle
        .update(dmReactions)
        .set({ dmId: newDmId, author: newAuthor })
        .where(eq(dmReactions.id, rx.id))
        .run();
    }
  }
}
