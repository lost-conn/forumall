/**
 * Guest → full-account "claim" (Forumall extension over spec §4.8 / §4.1).
 *
 * A signed-in GUEST account upgrades itself into a full account by choosing a
 * NEW permanent handle and setting a password. Because `users.handle` is the
 * primary key AND is embedded as the actor (`handle@domain`, or a bare local
 * handle) across most domain tables — and DM ids are byte-derived from the actor
 * pair (`deriveDmId`, §7.4) — a claim is a full identity rename that must
 * atomically rewrite the guest's identity EVERYWHERE in one transaction.
 *
 * The caller keeps its existing Ed25519 device keypair + keyId; only the actor
 * the keyId resolves to changes (we rewrite `device_keys.user_handle`), so the
 * SAME private key keeps signing — now as the new actor. After the claim the row
 * has `guest = 0` and a non-null `password_hash`, so the EXISTING password-login
 * flow (`http/auth.ts`) works unchanged.
 *
 * ## Identity-reference map (the two storage forms)
 * Bare LOCAL handle columns get the new bare handle; full ACTOR columns
 * (`handle@domain`) get `newHandle@<canonicalDomain>`:
 *
 *  bare-handle:
 *    - users.handle (PK)
 *    - device_keys.user_handle
 *    - bootstrap_tokens.handle  (deleted instead — ephemeral, handle-bound)
 *    - dm_messages.owner, dm_conversations.owner
 *    - privacy_settings.handle, presence.handle, read_markers.handle
 *    - follows.owner, contacts.owner
 *    - notifications.recipient, notification_endpoints.owner,
 *      notification_preferences.owner, push_subscriptions.recipient
 *    - discover_features.added_by  (admin audit; a guest can never be admin, so
 *      this never matches — rewritten for completeness/defence-in-depth)
 *
 *  actor (`handle@domain`):
 *    - group_members.user, join_requests.user
 *    - groups.owner, channels: (none — channels carry no actor)
 *    - messages.author, reactions.author, dm_reactions.author
 *    - dm_messages.author, dm_conversations.counterparty
 *    - invites.created_by, media.owner
 *    - contacts.user (the OTHER side's row pointing AT us, and our own outgoing
 *      `user` values are remote — see note below)
 *    - follows.channel (a self-authored channel URI could embed us — NOT
 *      rewritten; see deliberate-exclusions note)
 *
 *  dm-special (re-derive dmId): any dm_messages / dm_conversations / dm_reactions
 *  row where the guest is author/owner/counterparty has its `dm_id` recomputed
 *  with the new actor.
 */
import { canonicalAuthority, deriveDmId } from "@forumall/shared";
import { and, eq, like } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import {
  type UserRow,
  bootstrapTokens,
  contacts,
  deviceKeys,
  discoverFeatures,
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
import { GUEST_HANDLE_PREFIX, HandleSchema } from "./handle.ts";
import { hashPassword } from "./password.ts";

/** Input to {@link claimGuestAccount}. */
export interface ClaimGuestInput {
  /** The new permanent handle the guest is claiming (validated here). */
  readonly newHandle: string;
  /** The plaintext password to set (Argon2id-hashed before storage). */
  readonly password: string;
  /** Optional display name to set on the claimed account. */
  readonly displayName?: string | undefined;
}

/** Result of a successful {@link claimGuestAccount}. */
export interface ClaimGuestResult {
  /** The new canonical actor (`newHandle@<domain>`). */
  readonly actor: string;
  /** The new bare handle. */
  readonly handle: string;
}

/**
 * Atomically upgrade the guest account `currentHandle` into a full account named
 * `newHandle` with the given password, rewriting its identity across every table
 * that embeds it (see the module header for the full map). Re-derives the `dm_id`
 * of every DM row the guest participates in.
 *
 * Validation (in order):
 *  - the caller row must exist (`AppError.notFound`) and be a guest
 *    (`AppError.conflict` "account is already a full account");
 *  - `newHandle` must satisfy {@link HandleSchema} and must NOT start with the
 *    reserved `guest_` prefix (`AppError.badRequest`);
 *  - `newHandle` must be free, case-insensitively (`AppError.conflict`).
 *
 * @param currentHandle the caller's (guest's) current bare handle.
 */
export function claimGuestAccount(
  db: Db,
  config: Config,
  currentHandle: string,
  input: ClaimGuestInput,
): ClaimGuestResult {
  const domain = canonicalAuthority(config.domain);

  // -- Caller must be an existing guest ------------------------------------
  const row = db.drizzle
    .select()
    .from(users)
    .where(eq(users.handle, currentHandle))
    .limit(1)
    .all()[0] as UserRow | undefined;
  if (!row) throw AppError.notFound({ detail: "no such user" });
  if (!row.guest) {
    throw AppError.conflict({ detail: "account is already a full account" });
  }

  // -- Validate the requested handle ---------------------------------------
  const parsed = HandleSchema.safeParse(input.newHandle);
  if (!parsed.success) {
    throw AppError.badRequest({ detail: parsed.error.issues[0]?.message ?? "invalid handle" });
  }
  const newHandle = parsed.data;
  if (newHandle.startsWith(GUEST_HANDLE_PREFIX)) {
    throw AppError.badRequest({
      detail: `handle must not start with the reserved '${GUEST_HANDLE_PREFIX}' prefix`,
    });
  }
  if (newHandle === currentHandle) {
    // Defensive: a guest handle is `guest_…`, already rejected above; but guard
    // the degenerate "rename to self" anyway.
    throw AppError.badRequest({ detail: "new handle must differ from the current handle" });
  }

  // -- The new handle must be free (case-insensitive, as register checks) ---
  const taken = db.drizzle
    .select({ handle: users.handle })
    .from(users)
    .where(like(users.handle, newHandle))
    .all()
    .some((r) => r.handle.toLowerCase() === newHandle.toLowerCase());
  if (taken) throw AppError.conflict({ detail: "handle is already registered" });

  const oldActor = `${currentHandle}@${domain}`;
  const newActor = `${newHandle}@${domain}`;
  const passwordHash = hashPassword(input.password, config.argon2);

  db.sqlite.transaction(() => {
    // (a) The users row: flip to a full account + the new identity.
    db.drizzle
      .update(users)
      .set({
        handle: newHandle,
        passwordHash,
        guest: false,
        expiresAt: null,
        updatedAt: Date.now(),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      })
      .where(eq(users.handle, currentHandle))
      .run();

    // (b) Bare-local-handle columns → newHandle.
    db.drizzle
      .update(deviceKeys)
      .set({ userHandle: newHandle })
      .where(eq(deviceKeys.userHandle, currentHandle))
      .run();
    db.drizzle
      .update(privacySettings)
      .set({ handle: newHandle })
      .where(eq(privacySettings.handle, currentHandle))
      .run();
    db.drizzle
      .update(presence)
      .set({ handle: newHandle })
      .where(eq(presence.handle, currentHandle))
      .run();
    db.drizzle
      .update(readMarkers)
      .set({ handle: newHandle })
      .where(eq(readMarkers.handle, currentHandle))
      .run();
    db.drizzle
      .update(follows)
      .set({ owner: newHandle })
      .where(eq(follows.owner, currentHandle))
      .run();
    db.drizzle
      .update(contacts)
      .set({ owner: newHandle })
      .where(eq(contacts.owner, currentHandle))
      .run();
    db.drizzle
      .update(notifications)
      .set({ recipient: newHandle })
      .where(eq(notifications.recipient, currentHandle))
      .run();
    db.drizzle
      .update(notificationEndpoints)
      .set({ owner: newHandle })
      .where(eq(notificationEndpoints.owner, currentHandle))
      .run();
    db.drizzle
      .update(notificationPreferences)
      .set({ owner: newHandle })
      .where(eq(notificationPreferences.owner, currentHandle))
      .run();
    db.drizzle
      .update(pushSubscriptions)
      .set({ recipient: newHandle })
      .where(eq(pushSubscriptions.recipient, currentHandle))
      .run();
    db.drizzle
      .update(discoverFeatures)
      .set({ addedBy: newHandle })
      .where(eq(discoverFeatures.addedBy, currentHandle))
      .run();

    // (c) Full-actor columns (`handle@domain`) → newActor.
    db.drizzle
      .update(groupMembers)
      .set({ user: newActor })
      .where(eq(groupMembers.user, oldActor))
      .run();
    db.drizzle
      .update(joinRequests)
      .set({ user: newActor })
      .where(eq(joinRequests.user, oldActor))
      .run();
    db.drizzle.update(groups).set({ owner: newActor }).where(eq(groups.owner, oldActor)).run();
    db.drizzle
      .update(messages)
      .set({ author: newActor })
      .where(eq(messages.author, oldActor))
      .run();
    db.drizzle
      .update(reactions)
      .set({ author: newActor })
      .where(eq(reactions.author, oldActor))
      .run();
    db.drizzle
      .update(invites)
      .set({ createdBy: newActor })
      .where(eq(invites.createdBy, oldActor))
      .run();
    db.drizzle.update(media).set({ owner: newActor }).where(eq(media.owner, oldActor)).run();
    // The OTHER side of a contact relationship points AT us via `user`.
    db.drizzle.update(contacts).set({ user: newActor }).where(eq(contacts.user, oldActor)).run();

    // (d) DM re-keying. Any dm row the guest participates in must have its
    // `dm_id` recomputed with the new actor (the byte-derived two-party id),
    // plus the author/owner/counterparty actor field updated.
    rekeyDmMessages(db, currentHandle, oldActor, newHandle, newActor);
    rekeyDmConversations(db, currentHandle, oldActor, newHandle, newActor);
    rekeyDmReactions(db, oldActor, newActor);

    // (e) Delete the guest's ephemeral, handle-bound bootstrap tokens.
    db.drizzle.delete(bootstrapTokens).where(eq(bootstrapTokens.handle, currentHandle)).run();
  })();

  return { actor: newActor, handle: newHandle };
}

/**
 * Re-key `dm_messages` rows the guest authored or received. The `dm_id` is the
 * deterministic two-party id; recompute it from the (counterparty, newActor)
 * pair. `owner` is the bare local recipient handle; `author` is the full actor.
 *
 *  - rows the guest RECEIVED live in the guest's inbox (`owner = currentHandle`).
 *    Their counterparty is `author`; the new dm_id = deriveDmId(author, newActor).
 *    `owner` → newHandle.
 *  - rows the guest SENT live in the recipient's inbox (`author = oldActor`).
 *    Their counterparty is `owner@domain` (local recipient). The new dm_id =
 *    deriveDmId(owner@domain, newActor). `author` → newActor.
 *
 * A self-DM row (guest both owner and author) satisfies both and is handled once
 * by the owner pass (dm_id = deriveDmId(newActor, newActor)); the author pass
 * then only updates `author` (the dm_id is already correct).
 */
function rekeyDmMessages(
  db: Db,
  currentHandle: string,
  oldActor: string,
  newHandle: string,
  newActor: string,
): void {
  const domain = newActor.slice(newActor.lastIndexOf("@") + 1);

  // Rows in the guest's own inbox (received, or self-DM).
  const received = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.owner, currentHandle))
    .all();
  for (const r of received) {
    const counterparty = r.author === oldActor ? newActor : r.author;
    const newDmId = deriveDmId(counterparty, newActor);
    db.drizzle
      .update(dmMessages)
      .set({
        owner: newHandle,
        dmId: newDmId,
        ...(r.author === oldActor ? { author: newActor } : {}),
      })
      .where(eq(dmMessages.id, r.id))
      .run();
  }

  // Rows the guest SENT that sit in some OTHER local recipient's inbox. (Self-DM
  // rows were re-keyed by the loop above — their `author` is already `newActor`,
  // so they no longer match `author = oldActor` and are not double-processed.)
  const stillOldAuthor = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.author, oldActor))
    .all();
  for (const r of stillOldAuthor) {
    // The recipient inbox owner is a bare local handle; its actor is owner@domain.
    const counterpartyActor = `${r.owner}@${domain}`;
    const newDmId = deriveDmId(counterpartyActor, newActor);
    db.drizzle
      .update(dmMessages)
      .set({ author: newActor, dmId: newDmId })
      .where(eq(dmMessages.id, r.id))
      .run();
  }
}

/**
 * Re-key `dm_conversations`. A conversation row is `(owner, dmId, counterparty)`.
 *  - the guest's OWN inbox rows: `owner = currentHandle` → newHandle; if the
 *    counterparty was the guest's old actor (self-DM) it becomes newActor; the
 *    dm_id is recomputed from (counterparty, newActor).
 *  - rows in another local user's inbox WHERE the counterparty is the guest:
 *    `counterparty = oldActor` → newActor; dm_id recomputed from (owner@domain,
 *    newActor).
 */
function rekeyDmConversations(
  db: Db,
  currentHandle: string,
  oldActor: string,
  newHandle: string,
  newActor: string,
): void {
  const domain = newActor.slice(newActor.lastIndexOf("@") + 1);

  const owned = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, currentHandle))
    .all();
  for (const r of owned) {
    const counterparty = r.counterparty === oldActor ? newActor : r.counterparty;
    const newDmId = deriveDmId(counterparty, newActor);
    // Delete + reinsert: the PK is (owner, dmId), and both change.
    db.drizzle
      .delete(dmConversations)
      .where(and(eq(dmConversations.owner, r.owner), eq(dmConversations.dmId, r.dmId)))
      .run();
    db.drizzle
      .insert(dmConversations)
      .values({
        owner: newHandle,
        dmId: newDmId,
        counterparty,
        updatedAt: r.updatedAt,
        lastMessageSeq: r.lastMessageSeq,
      })
      .run();
  }

  const pointingAtGuest = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.counterparty, oldActor))
    .all();
  for (const r of pointingAtGuest) {
    const counterpartyActor = `${r.owner}@${domain}`;
    const newDmId = deriveDmId(counterpartyActor, newActor);
    db.drizzle
      .delete(dmConversations)
      .where(and(eq(dmConversations.owner, r.owner), eq(dmConversations.dmId, r.dmId)))
      .run();
    db.drizzle
      .insert(dmConversations)
      .values({
        owner: r.owner,
        dmId: newDmId,
        counterparty: newActor,
        updatedAt: r.updatedAt,
        lastMessageSeq: r.lastMessageSeq,
      })
      .run();
  }
}

/**
 * Re-key `dm_reactions`. A reaction targets a stored DM message scoped by
 * `(dm_id, message_id)`. After the messages above are re-keyed, every reaction
 * whose `dm_id` referenced a re-keyed message must be updated to the new `dm_id`,
 * and any reaction the guest AUTHORED must have its `author` updated.
 *
 * We resolve each reaction's new `dm_id` by joining to its target message
 * (`message_id`), which already carries the freshly-rewritten `dm_id`.
 */
function rekeyDmReactions(db: Db, oldActor: string, newActor: string): void {
  const all = db.drizzle.select().from(dmReactions).all();
  for (const rx of all) {
    const msg = db.drizzle
      .select({ dmId: dmMessages.dmId })
      .from(dmMessages)
      .where(eq(dmMessages.id, rx.messageId))
      .limit(1)
      .all()[0];
    const needsDmId = msg && msg.dmId !== rx.dmId;
    const needsAuthor = rx.author === oldActor;
    if (!needsDmId && !needsAuthor) continue;
    db.drizzle
      .update(dmReactions)
      .set({
        ...(needsDmId ? { dmId: msg.dmId } : {}),
        ...(needsAuthor ? { author: newActor } : {}),
      })
      .where(eq(dmReactions.id, rx.id))
      .run();
  }
}
