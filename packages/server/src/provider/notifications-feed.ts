/**
 * Inbound notifications-feed storage + detection (a provider-LOCAL extension —
 * NOT in the OFSCP v0.1 object model, and DISTINCT from the §10 outbound
 * notification *webhooks* in `provider/notifications.ts`). Owns the
 * `notifications` row lifecycle and the @mention / thread-reply detection that
 * runs on channel `message.create`.
 *
 * ## What gets a row
 * On a channel message create we derive zero or more notifications:
 *  - **mention** — for each `@handle` / `@handle@domain` parsed out of the
 *    message body whose resolved actor is a LOCAL user (exists in `users`) and is
 *    not the author. Remote/unknown mentions are silently dropped (the federation
 *    boundary: only a local recipient gets a local row).
 *  - **reply** — when the message carries a `reply` reference, the PARENT
 *    message's author, if that author is a LOCAL user and not the new author.
 *
 * The author is always self-excluded. Rows dedupe on
 * `(recipient, type, sourceMessageId)` via the unique index, so a message that
 * mentions the same user twice (or replies to + mentions them) yields at most one
 * row per (recipient, type).
 *
 * ## State (separate seen + read)
 * Two independent nullable timestamps: `seenAt` (the row appeared in the user's
 * inbox list — a badge signal) and `readAt` (the user acted on it). Marking read
 * also stamps seen if unset (read implies seen). Both marks are idempotent and
 * scoped to the recipient (a caller can only mark their own rows).
 *
 * State is private + per-account and is NEVER federated.
 */
import { type Notification, NotificationSchema, rfc3339Timestamp } from "@forumall/shared";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import {
  type NotificationRow,
  groupMembers,
  messages,
  notifications,
  users,
} from "../db/schema.ts";
import { decodeCursor, encodeCursor } from "./membership.ts";
import { getEffectiveMode } from "./notification-prefs.ts";

/** `id` prefix for a notification (`ntf_<base64url>`). */
const NOTIFICATION_ID_PREFIX = "ntf_";
/** Random bytes of entropy for a notification id (16 = 128 bits). */
const NOTIFICATION_ID_BYTES = 16;

/** Default + max page size for the feed listing. */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 30;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated notification id (`ntf_<base64url>`). */
function mintNotificationId(): string {
  const raw = new Uint8Array(NOTIFICATION_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${NOTIFICATION_ID_PREFIX}${toBase64Url(raw)}`;
}

// ---------------------------------------------------------------------------
// Mention parsing
// ---------------------------------------------------------------------------

/**
 * Parse `@handle` and `@handle@domain` mentions out of freeform message text.
 *
 * The handle body matches the actual handle shape used across this codebase
 * (lowercase-ish alphanumerics plus `_`, `.`, `-`; e.g. `alice`, `guest_ab12`),
 * and stops before trailing punctuation so `@alice,` parses `alice`. The optional
 * `@domain` suffix matches a dotted host or `localhost[:port]` (the dev/test
 * authority). The leading `@` must not be preceded by a word char, so an email
 * address `a@b.com` in prose does NOT register as a bare mention of `b.com`.
 *
 * Returns canonical `handle@domain` actors. A bare `@alice` resolves to
 * `localDomain`; an explicit `@alice@other.com` keeps its domain. Duplicates are
 * collapsed (order-preserving).
 */
const MENTION_RE =
  /(?<![\w@])@([a-z0-9][a-z0-9_.-]*?)(?:@([a-z0-9.-]+\.[a-z]{2,}|localhost(?::\d+)?))?(?=[^a-z0-9_.@-]|$)/gi;

export function detectMentions(text: string, localDomain: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const handle = (m[1] ?? "").toLowerCase();
    if (!handle) continue;
    // Strip a trailing dot/dash that the lazy body may have left dangling
    // (e.g. "@alice." → "alice"); a handle never ends in punctuation here.
    const cleanHandle = handle.replace(/[.\-_]+$/, "");
    if (!cleanHandle) continue;
    const domain = (m[2] ?? localDomain).toLowerCase();
    const actor = `${cleanHandle}@${domain}`;
    if (seen.has(actor)) continue;
    seen.add(actor);
    out.push(actor);
  }
  return out;
}

/** Whether `handle` is a LOCAL user on this provider (exists in `users`). */
function isLocalUser(db: Db, handle: string): boolean {
  return (
    db.drizzle
      .select({ h: users.handle })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1)
      .all().length > 0
  );
}

// ---------------------------------------------------------------------------
// Row mapping + creation
// ---------------------------------------------------------------------------

/** Map a stored row to the canonical, schema-valid `Notification`. */
export function rowToNotification(row: NotificationRow): Notification {
  return NotificationSchema.parse({
    id: row.id,
    type: row.type,
    sourceMessageId: row.sourceMessageId,
    channelId: row.channelId,
    groupId: row.groupId,
    author: row.author,
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    ...(row.seenAt != null ? { seenAt: rfc3339Timestamp(new Date(row.seenAt)) } : {}),
    ...(row.readAt != null ? { readAt: rfc3339Timestamp(new Date(row.readAt)) } : {}),
  });
}

/** A notification to create (recipient is a resolved LOCAL handle). */
export interface NotificationInput {
  readonly recipient: string;
  readonly type: "mention" | "reply" | "message";
  readonly sourceMessageId: string;
  readonly channelId: string;
  readonly groupId: string;
  readonly author: string;
}

/**
 * A freshly-created notification paired with its LOCAL recipient handle. The
 * canonical {@link Notification} intentionally does not carry the bare recipient
 * (it is private state), so the fan-out caller reads `recipient` here to target
 * `hub.publishToActor`.
 */
export interface CreatedNotification {
  /** LOCAL recipient handle (the row's `recipient`). */
  readonly recipient: string;
  /** The canonical notification object (no `recipient` field). */
  readonly notification: Notification;
  /** The notification kind (mirrors `notification.type`), for fan-out branching. */
  readonly type: "mention" | "reply" | "message";
}

/**
 * Bulk-insert notification rows, deduping on `(recipient, type, sourceMessageId)`
 * (the unique index, with `onConflictDoNothing` so a duplicate is a clean no-op).
 * Returns the rows that were actually inserted, each paired with its recipient
 * handle, in insert order. Runs in one transaction.
 */
export function createNotifications(
  db: Db,
  inputs: readonly NotificationInput[],
): CreatedNotification[] {
  if (inputs.length === 0) return [];
  const now = Date.now();
  const created: CreatedNotification[] = [];
  db.sqlite.transaction(() => {
    // Collapse exact (recipient, type, sourceMessageId) duplicates within the
    // batch before hitting the DB.
    const batchSeen = new Set<string>();
    for (const input of inputs) {
      const key = `${input.recipient}\u0000${input.type}\u0000${input.sourceMessageId}`;
      if (batchSeen.has(key)) continue;
      batchSeen.add(key);
      const row: NotificationRow = {
        id: mintNotificationId(),
        recipient: input.recipient,
        type: input.type,
        sourceMessageId: input.sourceMessageId,
        channelId: input.channelId,
        groupId: input.groupId,
        author: input.author,
        createdAt: now,
        seenAt: null,
        readAt: null,
      };
      const res = db.drizzle.insert(notifications).values(row).onConflictDoNothing().run();
      // bun:sqlite exposes `changes`; a conflict (already-existing row) is 0.
      // drizzle types `.run()` as void, but the bun-sqlite driver returns the
      // RunResult at runtime — read `changes` through an unknown cast.
      const changes = (res as unknown as { changes?: number }).changes ?? 0;
      if (changes > 0) {
        created.push({
          recipient: row.recipient,
          notification: rowToNotification(row),
          type: input.type,
        });
      }
    }
  })();
  return created;
}

/**
 * Derive every notification a channel message create should produce, applying
 * the local-recipient + self-exclude rules, and persist them. Returns the rows
 * actually created (deduped), for the WS fan-out.
 *
 *  - **mentions**: parse `@…` out of the message text, resolve each to a local
 *    user, exclude the author.
 *  - **reply**: if `replyToId` is set, look up the parent message's author; if it
 *    is a local user and not the author, create a `reply` row.
 *
 * `localDomain` is this provider's canonical authority (so a bare `@alice`
 * resolves locally and a `@alice@<thisHost>` is recognized as local).
 */
export function notifyForChannelMessage(
  db: Db,
  params: {
    readonly text: string;
    readonly author: string;
    readonly sourceMessageId: string;
    readonly channelId: string;
    readonly groupId: string;
    readonly localDomain: string;
    /** Parent message id when this message is a reply, else undefined. */
    readonly replyToId?: string | undefined;
  },
): CreatedNotification[] {
  const { text, author, sourceMessageId, channelId, groupId, localDomain, replyToId } = params;
  const inputs: NotificationInput[] = [];
  // LOCAL recipient handles already covered by a mention/reply row (so the
  // `all`-path does not also create a `message` row for them).
  const directRecipients = new Set<string>();

  // --- Mentions ---------------------------------------------------------
  for (const actor of detectMentions(text, localDomain)) {
    if (actor === author) continue; // self-exclude
    const at = actor.lastIndexOf("@");
    const handle = actor.slice(0, at);
    const domain = actor.slice(at + 1);
    // Local-recipient only: the resolved actor must be hosted here AND exist.
    if (domain !== localDomain) continue;
    if (!isLocalUser(db, handle)) continue;
    // Muted: a `none` effective mode suppresses the mention notification.
    if (getEffectiveMode(db, handle, channelId, groupId) === "none") continue;
    directRecipients.add(handle);
    inputs.push({
      recipient: handle,
      type: "mention",
      sourceMessageId,
      channelId,
      groupId,
      author,
    });
  }

  // --- Thread reply -----------------------------------------------------
  if (replyToId) {
    const parent = db.drizzle
      .select({ author: messages.author })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.id, replyToId)))
      .limit(1)
      .all()[0];
    if (parent && parent.author !== author) {
      const at = parent.author.lastIndexOf("@");
      const handle = at > 0 ? parent.author.slice(0, at) : parent.author;
      const domain = at > 0 ? parent.author.slice(at + 1) : "";
      // Muted: a `none` effective mode suppresses the reply notification.
      if (
        domain === localDomain &&
        isLocalUser(db, handle) &&
        getEffectiveMode(db, handle, channelId, groupId) !== "none"
      ) {
        directRecipients.add(handle);
        inputs.push({
          recipient: handle,
          type: "reply",
          sourceMessageId,
          channelId,
          groupId,
          author,
        });
      }
    }
  }

  // --- `all`-mode members -----------------------------------------------
  // Every LOCAL group member whose effective mode is `all`, excluding the author
  // and anyone already getting a mention/reply for this message, gets a
  // `message` notification.
  for (const handle of localMemberHandles(db, groupId, localDomain)) {
    if (directRecipients.has(handle)) continue;
    const authorHandle = author.endsWith(`@${localDomain}`)
      ? author.slice(0, author.lastIndexOf("@"))
      : null;
    if (authorHandle !== null && handle === authorHandle) continue; // self-exclude
    if (getEffectiveMode(db, handle, channelId, groupId) !== "all") continue;
    inputs.push({
      recipient: handle,
      type: "message",
      sourceMessageId,
      channelId,
      groupId,
      author,
    });
  }

  return createNotifications(db, inputs);
}

/**
 * The bare LOCAL handles of every member of `groupId` (members are stored as
 * canonical `handle@domain` actors; we keep only those hosted on `localDomain`
 * and resolving to an existing local user). Used by the `all`-mode fan-out.
 */
function localMemberHandles(db: Db, groupId: string, localDomain: string): string[] {
  const rows = db.drizzle
    .select({ user: groupMembers.user })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .all();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { user } of rows) {
    const at = user.lastIndexOf("@");
    if (at <= 0) continue;
    const handle = user.slice(0, at);
    const domain = user.slice(at + 1);
    if (domain !== localDomain) continue;
    if (seen.has(handle)) continue;
    if (!isLocalUser(db, handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feed listing (opaque cursor over (createdAt, id), newest-first)
// ---------------------------------------------------------------------------

/** Keyset position for the feed: `(createdAt, id)` — a stable total order. */
interface NotificationCursor {
  readonly createdAt: number;
  readonly id: string;
}

/** Options for {@link listNotifications}. */
export interface ListNotificationsOptions {
  /** Filter to a single type, or all when omitted. */
  readonly type?: "mention" | "reply" | "message";
  /** Page size; clamped to {@link MAX_NOTIFICATION_PAGE_SIZE}. */
  readonly limit?: number;
  /** Opaque cursor to page from (exclusive); omit for the first page. */
  readonly cursor?: string | null;
}

/** A page of notifications plus the opaque cursor for the next page. */
export interface NotificationPage {
  readonly items: Notification[];
  readonly nextCursor?: string;
}

/**
 * List a recipient's notifications newest-first (`createdAt DESC`, tiebroken by
 * `id DESC` for a stable total order), keyset-paged with the shared opaque
 * cursor. `type` filters to mentions or replies; omit for both.
 */
export function listNotifications(
  db: Db,
  recipient: string,
  opts: ListNotificationsOptions = {},
): NotificationPage {
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_NOTIFICATION_PAGE_SIZE)
      : DEFAULT_NOTIFICATION_PAGE_SIZE;
  const after = opts.cursor ? decodeCursor<NotificationCursor>(opts.cursor) : null;

  const base = opts.type
    ? and(eq(notifications.recipient, recipient), eq(notifications.type, opts.type))
    : eq(notifications.recipient, recipient);

  // Keyset predicate: rows strictly past (createdAt, id) in DESC order —
  // (createdAt < a) OR (createdAt = a AND id < id).
  const where = after
    ? and(
        base,
        or(
          lt(notifications.createdAt, after.createdAt),
          and(eq(notifications.createdAt, after.createdAt), lt(notifications.id, after.id)),
        ),
      )
    : base;

  const rows = db.drizzle
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined;

  return {
    items: pageRows.map(rowToNotification),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mark seen / read
// ---------------------------------------------------------------------------

/**
 * Mark notifications SEEN for `recipient`: stamp `seenAt = now` on rows that are
 * not yet seen. `ids` scopes to those specific rows (intersected with the
 * recipient — a caller can only touch their own); omitted/empty marks ALL of the
 * recipient's unseen rows. Idempotent. Returns the number of rows touched.
 */
export function markSeen(db: Db, recipient: string, ids?: readonly string[]): number {
  const now = Date.now();
  const idFilter = ids && ids.length > 0 ? inArray(notifications.id, [...ids]) : undefined;
  const res = db.drizzle
    .update(notifications)
    .set({ seenAt: now })
    .where(
      and(
        eq(notifications.recipient, recipient),
        isNull(notifications.seenAt),
        ...(idFilter ? [idFilter] : []),
      ),
    )
    .run();
  return (res as unknown as { changes?: number }).changes ?? 0;
}

/**
 * Mark notifications READ for `recipient`: stamp `readAt = now` on rows not yet
 * read, AND `seenAt = now` where it is still unset (read implies seen). `ids`
 * scopes to those rows (recipient-intersected); omitted/empty marks ALL unread.
 * Idempotent. Returns the number of rows touched.
 */
export function markRead(db: Db, recipient: string, ids?: readonly string[]): number {
  const now = Date.now();
  const idFilter = ids && ids.length > 0 ? inArray(notifications.id, [...ids]) : undefined;
  const res = db.drizzle
    .update(notifications)
    .set({ readAt: now, seenAt: sql`COALESCE(${notifications.seenAt}, ${now})` })
    .where(
      and(
        eq(notifications.recipient, recipient),
        isNull(notifications.readAt),
        ...(idFilter ? [idFilter] : []),
      ),
    )
    .run();
  return (res as unknown as { changes?: number }).changes ?? 0;
}

/** Per-type unseen counts for `recipient`, for the inbox-tab badges. */
export interface NotificationCounts {
  readonly mention: number;
  readonly reply: number;
  readonly message: number;
}

/**
 * Count UNSEEN notifications per type for `recipient` (the badge basis). An
 * absent type is reported as 0.
 */
export function unreadCounts(db: Db, recipient: string): NotificationCounts {
  const rows = db.drizzle
    .select({ type: notifications.type, n: sql<number>`COUNT(*)` })
    .from(notifications)
    .where(and(eq(notifications.recipient, recipient), isNull(notifications.seenAt)))
    .groupBy(notifications.type)
    .all();
  const counts = { mention: 0, reply: 0, message: 0 };
  for (const r of rows) {
    if (r.type === "mention") counts.mention = Number(r.n);
    else if (r.type === "reply") counts.reply = Number(r.n);
    else if (r.type === "message") counts.message = Number(r.n);
  }
  return counts;
}
