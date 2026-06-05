/**
 * Presence storage, effective-state derivation, per-viewer filtering, the
 * connection-scoped subscription registry, and the privacy-filtered fan-out
 * (spec §6.4, §7.5).
 *
 * This module is the single source of truth shared by BOTH presence surfaces —
 * the WebSocket (`presence.subscribe` / `presence.set` / connection-derived
 * online/offline, in `http/ws.ts`) and the REST endpoints
 * (`GET /api/users/{ref}/presence`, `PUT /api/me/presence`, in `http/users.ts`).
 * Routing the two surfaces through the same {@link effectivePresence} +
 * {@link filterPresenceFor} guarantees the spec's hard requirement that they
 * "MUST return consistent results for the same viewer".
 *
 * ## Model (§6.4 / §7.5)
 * Stored presence (`presence` table) holds only the user's EXPLICIT availability
 * (`online | away | dnd`, default `online`) + optional `status`, plus a
 * `lastSeen` stamped when their last live connection drops. `offline` is never
 * stored — it is the *effective* state when the user has no live WS connection:
 *
 *   effective availability = (live connections == 0) ? "offline" : explicit
 *
 * so a connected user shows online/away/dnd (their explicit setting), and a
 * disconnected user shows offline regardless of what they last set. An explicit
 * `away`/`dnd` + `status` persist across reconnects (a successful `authenticate`
 * never clobbers them).
 *
 * ## Privacy-filtered fan-out (§7.5, critical)
 * Every `presence.update` — and every REST read — is filtered per (subject,
 * viewer) through {@link filterPresenceFor}: a viewer NOT permitted by the
 * subject's `presenceVisibility` (with allow/deny overrides) sees a UNIFORM
 * `offline` presence (no `status`/`lastSeen`), indistinguishable from a genuinely
 * offline user. The subject always sees their own real presence (self-visibility
 * is inside {@link canView}).
 *
 * ## Subscription registry
 * {@link PresenceRegistry} maps `subject actor → set of subscriber HubConnections`.
 * It is connection-scoped exactly like channel subscriptions: a connection adds
 * subjects on `presence.subscribe`, removes them on `presence.unsubscribe`, and
 * is fully purged on disconnect. {@link fanOutPresence} walks the subscriber set
 * for a subject, computes the per-viewer-filtered presence for each subscriber
 * connection, and sends each its own copy.
 */
import { PresenceSchema, canonicalAuthority } from "@forumall/shared";
import { eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { type PresenceRow, presence } from "../db/schema.ts";
import { getPrivacySettings } from "./privacy.ts";
import { canView } from "./visibility.ts";
import type { Hub, HubConnection, OutboundEvent } from "./ws-hub.ts";

/** The explicit availability a user may store/set (never `offline`). */
export type ExplicitAvailability = "online" | "away" | "dnd";

/** The effective availability surfaced to clients (adds connection-derived `offline`). */
export type EffectiveAvailability = ExplicitAvailability | "offline";

/** A user's effective presence, before per-viewer filtering. */
export interface EffectivePresence {
  readonly availability: EffectiveAvailability;
  readonly status?: string;
  readonly lastSeen?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The raw presence row for `handle`, or `null` if the user never set one. */
export function getPresenceRow(db: Db, handle: string): PresenceRow | null {
  return (
    db.drizzle.select().from(presence).where(eq(presence.handle, handle)).limit(1).all()[0] ?? null
  );
}

/**
 * Update `handle`'s stored EXPLICIT availability/status (upsert). `offline` is
 * not a valid argument — the WS/REST layers reject it before reaching here.
 * `status` is replaced when provided and cleared when explicitly `null`; passing
 * `undefined` leaves the existing status untouched. Returns the updated row.
 */
export function setExplicitPresence(
  db: Db,
  handle: string,
  availability: ExplicitAvailability,
  status?: string | null,
): PresenceRow {
  const existing = getPresenceRow(db, handle);
  const now = Date.now();
  const nextStatus =
    status === undefined ? (existing?.status ?? null) : status === null ? null : status;

  const row: PresenceRow = {
    handle,
    availability,
    status: nextStatus,
    lastSeen: existing?.lastSeen ?? null,
    updatedAt: now,
  };

  db.drizzle
    .insert(presence)
    .values(row)
    .onConflictDoUpdate({
      target: presence.handle,
      set: { availability, status: nextStatus, updatedAt: now },
    })
    .run();

  return row;
}

/**
 * Stamp `handle`'s `lastSeen` to `now` (when their last live connection drops).
 * Upserts so a user who never explicitly set presence still records a lastSeen,
 * with the default explicit `online` (which only matters once they reconnect).
 */
export function markLastSeen(db: Db, handle: string, now: number = Date.now()): void {
  const existing = getPresenceRow(db, handle);
  if (existing) {
    db.drizzle
      .update(presence)
      .set({ lastSeen: now, updatedAt: now })
      .where(eq(presence.handle, handle))
      .run();
    return;
  }
  db.drizzle
    .insert(presence)
    .values({ handle, availability: "online", status: null, lastSeen: now, updatedAt: now })
    .run();
}

// ---------------------------------------------------------------------------
// Effective state + filtering
// ---------------------------------------------------------------------------

/** RFC 3339 from epoch millis. */
function isoFromMillis(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Compute `handle`'s EFFECTIVE presence (§6.4/§7.5), BEFORE per-viewer filtering.
 * Effective availability is `offline` when the user has no live WS connection;
 * otherwise it is their stored explicit availability (default `online`). `status`
 * and `lastSeen` come from the stored row.
 */
export function effectivePresence(
  db: Db,
  hub: Hub,
  handle: string,
  actor: string,
): EffectivePresence {
  const row = getPresenceRow(db, handle);
  const online = hub.liveConnectionCount(actor) > 0;
  const availability: EffectiveAvailability = online
    ? ((row?.availability as ExplicitAvailability | undefined) ?? "online")
    : "offline";

  return {
    availability,
    ...(row?.status != null ? { status: row.status } : {}),
    ...(row?.lastSeen != null ? { lastSeen: isoFromMillis(row.lastSeen) } : {}),
  };
}

/** The uniform `offline` presence an unauthorized viewer always sees (§7.5). */
function uniformOffline(): EffectivePresence {
  return { availability: "offline" };
}

/**
 * The per-viewer-filtered effective presence of `subjectHandle`, as the value
 * BOTH the WS fan-out and `GET /api/users/{ref}/presence` emit to `viewerActor`
 * (§7.5 "MUST return consistent results for the same viewer"). A viewer not
 * permitted by the subject's `presenceVisibility` (allow/deny applied) gets a
 * uniform `offline` (no `status`/`lastSeen`); the subject always sees their own
 * real presence (self-visibility handled inside {@link canView}).
 */
export function filterPresenceFor(
  db: Db,
  hub: Hub,
  config: Config,
  subjectHandle: string,
  viewerActor: { actor: string; handle: string; domain: string } | null,
): EffectivePresence {
  const host = canonicalAuthority(config.domain);
  const subjectActor = `${subjectHandle}@${host}`;
  const settings = getPrivacySettings(db, subjectHandle);

  const visible = canView(db, {
    subjectHandle,
    subjectDomain: host,
    viewerActor,
    policy: settings.presenceVisibility,
    allowList: settings.allowList,
    denyList: settings.denyList,
  });

  if (!visible) return uniformOffline();
  return effectivePresence(db, hub, subjectHandle, subjectActor);
}

/** Render an {@link EffectivePresence} as a schema-valid `Presence` object (§6.4). */
export function toPresence(eff: EffectivePresence) {
  return PresenceSchema.parse({
    availability: eff.availability,
    ...(eff.status !== undefined ? { status: eff.status } : {}),
    ...(eff.lastSeen !== undefined ? { lastSeen: eff.lastSeen } : {}),
    metadata: [],
  });
}

// ---------------------------------------------------------------------------
// Subscription registry
// ---------------------------------------------------------------------------

/**
 * Connection-scoped presence subscriptions (§7.5): a reverse index from a
 * subject actor to the set of {@link HubConnection}s currently subscribed to its
 * presence. Mirrors the hub's channel index but lives here because presence
 * subjects are actors, not channels, and the fan-out is per-(subject, viewer)
 * filtered (so it cannot reuse the hub's blind `publishToActor`).
 *
 * The WS handler adds subjects on `presence.subscribe`, drops them on
 * `presence.unsubscribe`, and calls {@link removeConnection} on disconnect to
 * purge the connection from every subject's set.
 */
export class PresenceRegistry {
  /** subject actor → connections subscribed to that subject's presence. */
  private readonly bySubject = new Map<string, Set<HubConnection>>();
  /** connection → the subject actors it is subscribed to (for O(1) teardown). */
  private readonly subjectsByConn = new Map<HubConnection, Set<string>>();

  /** Subscribe `conn` to each subject's presence. Idempotent per subject. */
  subscribe(conn: HubConnection, subjects: readonly string[]): void {
    let owned = this.subjectsByConn.get(conn);
    if (!owned) {
      owned = new Set();
      this.subjectsByConn.set(conn, owned);
    }
    for (const subject of subjects) {
      owned.add(subject);
      let subs = this.bySubject.get(subject);
      if (!subs) {
        subs = new Set();
        this.bySubject.set(subject, subs);
      }
      subs.add(conn);
    }
  }

  /** Unsubscribe `conn` from each subject's presence. */
  unsubscribe(conn: HubConnection, subjects: readonly string[]): void {
    const owned = this.subjectsByConn.get(conn);
    for (const subject of subjects) {
      owned?.delete(subject);
      const subs = this.bySubject.get(subject);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) this.bySubject.delete(subject);
      }
    }
    if (owned && owned.size === 0) this.subjectsByConn.delete(conn);
  }

  /** Purge `conn` from every subject set it was subscribed to (on disconnect). */
  removeConnection(conn: HubConnection): void {
    const owned = this.subjectsByConn.get(conn);
    if (!owned) return;
    for (const subject of owned) {
      const subs = this.bySubject.get(subject);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) this.bySubject.delete(subject);
      }
    }
    this.subjectsByConn.delete(conn);
  }

  /** The connections currently subscribed to `subject`'s presence. */
  subscribersOf(subject: string): readonly HubConnection[] {
    const subs = this.bySubject.get(subject);
    return subs ? [...subs] : [];
  }
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/** Build a `presence.update` event for `user` carrying `presence` (§7.5). */
export function presenceUpdateEvent(user: string, presenceObj: unknown): OutboundEvent {
  return { type: "presence.update", data: { user, presence: presenceObj } };
}

/**
 * Fan out a `presence.update` for `subjectHandle` to every connection subscribed
 * to that subject (§7.5). Each subscriber's copy is independently filtered for
 * its OWN viewer through {@link filterPresenceFor}, so an unauthorized subscriber
 * receives a uniform `offline` while an authorized one receives the real state —
 * the exact value that viewer would get from `GET /api/users/{ref}/presence`.
 */
export function fanOutPresence(
  db: Db,
  hub: Hub,
  config: Config,
  registry: PresenceRegistry,
  subjectHandle: string,
): void {
  const host = canonicalAuthority(config.domain);
  const subjectActor = `${subjectHandle}@${host}`;
  const subscribers = registry.subscribersOf(subjectActor);
  if (subscribers.length === 0) return;

  for (const conn of subscribers) {
    const viewer = viewerOfActor(conn.actor, host);
    const eff = filterPresenceFor(db, hub, config, subjectHandle, viewer);
    hub.send(conn.socket, presenceUpdateEvent(subjectActor, toPresence(eff)));
  }
}

/**
 * Derive the {@link canView} viewer shape from a subscriber connection's actor.
 * The viewer is the authenticated connection actor; we split `handle@domain` and
 * set an empty handle for a non-local domain (the §6.1 tiers that need a local
 * handle — `contacts` — only match local viewers anyway via `areContacts`).
 */
function viewerOfActor(
  actor: string,
  host: string,
): { actor: string; handle: string; domain: string } {
  const at = actor.lastIndexOf("@");
  if (at <= 0) return { actor, handle: "", domain: host };
  const handle = actor.slice(0, at);
  const domain = canonicalAuthority(actor.slice(at + 1));
  return { actor, handle: domain === host ? handle : "", domain };
}
