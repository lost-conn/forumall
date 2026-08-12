/**
 * Opaque timeline-cursor codec + ordering (§7.1 / §7.2 / §7.4 share ONE space).
 *
 * Every message the provider hands us carries an opaque `cursor`:
 * `base64url(JSON.stringify({ seq }))`, where `seq` is the provider's globally
 * monotonic timeline position (see `packages/server/src/provider/messages.ts` —
 * REST history paging and the WS resume `since` are the SAME value). This module
 * is the client-side mirror of that codec, and the single place ordering
 * decisions about cursors are made.
 *
 * ## Why this module exists: cursors are NOT string-comparable
 * A cursor is base64 of JSON, so comparing the encoded strings — lexically, or
 * "length-then-lexical" — is **not order-preserving**. `{"seq":9}` and
 * `{"seq":10}` differ in length AND alphabet position; so do `99`/`100` and
 * `999`/`1000`. Ordering on the encoded text therefore flips at every decimal
 * rollover. Anywhere a cursor decides "which of these is newer" the string must
 * be DECODED first ({@link seqFromCursor}) and the `seq` compared numerically.
 * The stakes are not cosmetic: `chat.cursors[channelId]` is the WS resume
 * `since`, so picking the wrong "newest" cursor makes a reconnect either replay
 * messages or DROP them.
 *
 * ## The missing/undecodable-cursor rule (applied consistently everywhere)
 * Not every row has a usable cursor: a local optimistic echo has not been
 * acknowledged yet, and a locally-retained sent DM (§8.3 — the server keeps no
 * sender copy) may never get one. A forged or truncated cursor decodes to
 * nothing. For TIMELINE ORDERING, within an otherwise-tied position:
 *
 *   1. rows WITH a decodable cursor come FIRST, ascending by `seq`;
 *   2. rows WITHOUT one come AFTER, ordered by `id` for determinism.
 *
 * (A cursorless row is almost always a just-composed local message, i.e. the
 * newest thing in the window — so "after the cursored ones" is also the natural
 * render position. Callers that render newest-first simply negate the
 * comparator, which reverses the whole order including this clause.)
 *
 * That rule is for ORDERING only. Advancing the stored resume cursor is a
 * separate decision with the opposite bias — see {@link cursorAdvances}: an
 * absent or undecodable cursor must NEVER become the resume `since`.
 */

/**
 * Decode an opaque §7.2 message cursor to its `seq`, or `null` if it is absent
 * or malformed. Mirrors the server's `decodeMessageCursor` (base64url JSON
 * `{ seq }`); a forged/garbage cursor is treated as "no cursor" rather than
 * throwing.
 */
export function seqFromCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return null;
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, "base64").toString("utf8");
    const pos = JSON.parse(json) as { seq?: unknown };
    return typeof pos.seq === "number" ? pos.seq : null;
  } catch {
    return null;
  }
}

/**
 * Compare two opaque cursors as timeline positions: negative when `a` is older
 * than `b`, positive when newer, `0` when they are the same position (or when
 * NEITHER decodes). Decodes both and compares `seq` NUMERICALLY — never the
 * encoded strings.
 *
 * Undecodable/absent cursors sort AFTER decodable ones, per the module rule.
 * The result is a valid total order (antisymmetric + transitive), which is what
 * makes it safe to feed straight to `Array.prototype.sort`.
 */
export function compareCursors(a: string | undefined | null, b: string | undefined | null): number {
  const sa = seqFromCursor(a);
  const sb = seqFromCursor(b);
  if (sa === null && sb === null) return 0;
  if (sa === null) return 1; // cursorless sorts after
  if (sb === null) return -1;
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** The shape {@link compareByCursorThenId} orders: anything with an id + cursor. */
export interface CursoredItem {
  id: string;
  cursor?: string | undefined;
}

/**
 * Ascending timeline order for two rows: by decoded `seq` when both decode,
 * cursored-before-cursorless otherwise, falling back to `id` when the cursors
 * cannot separate them (both cursorless, or — impossible in practice, `seq` is
 * globally unique — an exact seq tie).
 *
 * The `id` fallback is what keeps this a STRICT total order, so repeatedly
 * re-sorting a mutating list (the DM store sorts on every upsert) is stable and
 * never thrashes.
 */
export function compareByCursorThenId(a: CursoredItem, b: CursoredItem): number {
  const byCursor = compareCursors(a.cursor, b.cursor);
  if (byCursor !== 0) return byCursor;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether `candidate` should replace `current` as a stored NEWEST cursor — i.e.
 * the WS resume `since`. True only when `candidate` decodes to a `seq` and that
 * seq is strictly greater than `current`'s (or `current` is absent/undecodable
 * and therefore useless as a resume point).
 *
 * Note the deliberate asymmetry with {@link compareCursors}: for ordering a
 * cursorless row sorts LAST (it is the freshest local echo), but a cursorless
 * value can never be a resume point — resuming from it would mean resuming from
 * nothing — so it must never advance the stored cursor.
 */
export function cursorAdvances(
  current: string | undefined | null,
  candidate: string | undefined | null,
): boolean {
  const next = seqFromCursor(candidate);
  if (next === null) return false;
  const cur = seqFromCursor(current);
  return cur === null || next > cur;
}
