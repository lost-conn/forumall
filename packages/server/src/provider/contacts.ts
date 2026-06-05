/**
 * Contacts storage + canonical-shape mapping (spec §6.7).
 *
 * Owns the `contacts` row lifecycle and the row ↔ canonical `Contact` mapping,
 * keeping the HTTP layer thin. A `Contact` is held from a LOCAL owner's
 * perspective: `(owner, user)` where `owner` is a local handle and `user` is the
 * other actor (`handle@domain`, local or remote). `direction` (`outgoing` |
 * `incoming`) is meaningful only while `state` is `pending`.
 *
 * ## Local vs. remote mirroring
 * For a fully-LOCAL pair both sides live in this provider, so a request/accept/
 * remove updates BOTH rows directly here. For a remote counterparty only the
 * local owner's row is touched; the acting client mirrors the change to the
 * counterparty's provider via `POST /api/federation/contacts` (P8 drives that
 * delivery; the federation receiver here applies the remote side).
 *
 * ## The `contacts` tier
 * {@link areContacts} answers the §6.1 `contacts` tier: the local subject must
 * hold an `accepted` row for the viewer. The provider trusts its own accepted
 * row, which only reaches `accepted` after the mutual handshake (both local rows
 * accepted, or — across providers — both providers' rows independently
 * converged via the federation receiver).
 */
import { type Contact, ContactSchema, rfc3339Timestamp } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type ContactRow, contacts } from "../db/schema.ts";

/** Contact relationship state. */
export type ContactState = "pending" | "accepted";
/** Contact direction (meaningful while `pending`). */
export type ContactDirection = "outgoing" | "incoming";

/** Map a stored contact row to the canonical, schema-valid `Contact` (§6.7). */
export function rowToContact(row: ContactRow): Contact {
  return ContactSchema.parse({
    user: row.user,
    state: row.state,
    // `direction` is meaningful only while pending; include it always (the
    // schema allows it on accepted too) so the client can render either state.
    direction: row.direction,
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    updatedAt: rfc3339Timestamp(new Date(row.updatedAt)),
    metadata: [],
  });
}

/** The raw contact row for (owner, user), or `null` if there is none. */
export function getContactRow(db: Db, owner: string, user: string): ContactRow | null {
  return (
    db.drizzle
      .select()
      .from(contacts)
      .where(and(eq(contacts.owner, owner), eq(contacts.user, user)))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Upsert a contact row for (owner, user) with the given `state` / `direction`.
 * If a row already exists it is updated (state/direction/updatedAt); otherwise a
 * fresh row is inserted. Returns the resulting canonical `Contact`.
 */
export function upsertContact(
  db: Db,
  owner: string,
  user: string,
  state: ContactState,
  direction: ContactDirection,
): Contact {
  const now = Date.now();
  const existing = getContactRow(db, owner, user);
  if (existing) {
    db.drizzle
      .update(contacts)
      .set({ state, direction, updatedAt: now })
      .where(and(eq(contacts.owner, owner), eq(contacts.user, user)))
      .run();
    return rowToContact({ ...existing, state, direction, updatedAt: now });
  }
  const row: ContactRow = { owner, user, state, direction, createdAt: now, updatedAt: now };
  db.drizzle.insert(contacts).values(row).run();
  return rowToContact(row);
}

/** Promote (owner, user) to `accepted`. Caller guarantees the row exists. */
export function acceptContact(db: Db, owner: string, user: string): Contact {
  db.drizzle
    .update(contacts)
    .set({ state: "accepted", updatedAt: Date.now() })
    .where(and(eq(contacts.owner, owner), eq(contacts.user, user)))
    .run();
  return rowToContact(getContactRow(db, owner, user) as ContactRow);
}

/** Remove the (owner, user) contact row. Idempotent (no-op if absent). */
export function removeContact(db: Db, owner: string, user: string): void {
  db.drizzle
    .delete(contacts)
    .where(and(eq(contacts.owner, owner), eq(contacts.user, user)))
    .run();
}

/** All of `owner`'s contacts (pending in both directions + accepted). */
export function listContacts(db: Db, owner: string): Contact[] {
  return db.drizzle
    .select()
    .from(contacts)
    .where(eq(contacts.owner, owner))
    .orderBy(contacts.createdAt)
    .all()
    .map(rowToContact);
}

/**
 * The §6.1 `contacts` tier check (used by the privacy/presence resolver):
 * `true` iff the LOCAL subject holds an `accepted` row for `viewerActor`.
 *
 * The provider trusts its own accepted record — which only reaches `accepted`
 * after the mutual handshake — so a single local lookup answers the tier for
 * both local and remote viewers.
 *
 * @param subjectHandle the LOCAL subject's handle (the row `owner`)
 * @param viewerActor   the viewing actor (`handle@domain`)
 */
export function areContacts(db: Db, subjectHandle: string, viewerActor: string): boolean {
  const row = getContactRow(db, subjectHandle, viewerActor);
  return row?.state === "accepted";
}
