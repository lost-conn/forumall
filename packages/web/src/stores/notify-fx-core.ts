/**
 * Notify-FX pure decision core — the testable, side-effect-free logic behind the
 * notification sound coordinator. Kept apart from `notify-fx.ts` (which owns the
 * WebAudio chime, the favicon canvas, the WS wiring) so the eligibility,
 * suppression, dedupe, and total-unread rules can be unit-tested without a DOM,
 * an AudioContext, or a live socket.
 *
 * ## The three event sources
 *  - `dm.message`           — a direct message landed (carries a `mine` flag).
 *  - `notification.created` — an @mention or a reply to you in a channel.
 *  - `message.created`      — any channel message (only the OPEN channel matters).
 *
 * ## Eligibility → suppression → dedupe (resolved in that order)
 *  1. {@link soundEligible} decides whether an event is a *candidate* for sound
 *     (self-excluded, policy-gated). For a channel `message.created` the policy
 *     comes from {@link notifyPolicyFor} — the seam a future "per-channel
 *     notification settings" card overrides.
 *  2. {@link suppressedByPresence} drops a candidate the user can already see land
 *     (app focused + watching that exact thread). Open-channel sounds therefore
 *     fire only when tabbed-away or scrolled-up.
 *  3. {@link Deduper} collapses the double-fire of a channel @mention (which
 *     arrives as BOTH `message.created` and `notification.created`) keyed on the
 *     shared source message id.
 */

/** The per-scope sound policy. The seam for the future per-channel settings card. */
export type NotifyPolicy = "all" | "mentions" | "none";

/**
 * Resolve the sound policy for a scope (channel id or dm id). **This is the
 * override point** for the deferred "Per channel/group notification settings"
 * card: a server-driven policy plugs in here, keyed on `scopeId`.
 *
 * Today's default:
 *  - the OPEN channel/thread → `"all"` (every message there is a candidate), so a
 *    message in the channel you're looking at can chime when you're tabbed away;
 *  - every other scope → `"mentions"` (only @mentions/replies, which arrive via
 *    `notification.created`, are candidates — a plain message in a background
 *    channel does NOT sound).
 */
export function notifyPolicyFor(scopeId: string, activeScopeId: string | null): NotifyPolicy {
  // NOTE: future per-channel/per-group settings override goes HERE — look up a
  // stored/server policy for `scopeId` and return it instead of this default.
  if (activeScopeId !== null && scopeId === activeScopeId) return "all";
  return "mentions";
}

/** A normalized candidate the coordinator evaluates for sound. */
export interface SoundCandidate {
  /** Source kind. */
  source: "dm.message" | "notification.created" | "message.created";
  /** The thread the event belongs to: a channel id or a dm id. */
  scopeId: string;
  /** The message id that triggered this (the DEDUPE key; shared across sources). */
  sourceMessageId: string;
  /** The event author `handle@domain` (undefined for DMs, which use `mine`). */
  author?: string;
  /** DM-only: true when the message is the current user's own send. */
  mine?: boolean;
}

/** Inputs that decide eligibility, independent of the event. */
export interface EligibilityContext {
  /** The current user's actor, or null when logged out. */
  me: string | null;
  /** The currently-open thread's scope id (channel id or dm id), or null. */
  activeScopeId: string | null;
}

/**
 * Is this candidate a *candidate* for sound (self-excluded + policy-gated)?
 *
 *  - `dm.message`: eligible iff NOT the user's own send (`!mine`).
 *  - `notification.created`: always eligible (a mention/reply you received) —
 *    self-mentions don't generate a notification server-side.
 *  - `message.created`: eligible iff authored by someone else AND the channel's
 *    policy is `"all"` — which, by {@link notifyPolicyFor}, is the OPEN channel.
 *    Background-channel messages are not eligible (their @mentions still chime via
 *    the `notification.created` path).
 */
export function soundEligible(c: SoundCandidate, ctx: EligibilityContext): boolean {
  switch (c.source) {
    case "dm.message":
      return c.mine !== true && c.author !== ctx.me;
    case "notification.created":
      return c.author !== ctx.me;
    case "message.created": {
      if (c.author === ctx.me) return false; // never sound your own message
      const policy = notifyPolicyFor(c.scopeId, ctx.activeScopeId);
      return policy === "all";
    }
    default:
      return false;
  }
}

/** Presence/focus inputs for suppression. */
export interface PresenceContext {
  /** Is the tab visible AND the window focused? */
  appFocused: boolean;
  /** The currently-open thread's scope id, or null. */
  activeScopeId: string | null;
}

/**
 * Suppress an otherwise-eligible candidate the user can already see land: the app
 * is focused AND this event belongs to the active (open) thread. A proxy for "the
 * message is visible on screen right now" — for the open channel this means the
 * chime fires only when tabbed-away or scrolled-up (the latter still produces the
 * in-view jump pill, not a sound).
 */
export function suppressedByPresence(scopeId: string, pres: PresenceContext): boolean {
  return pres.appFocused && pres.activeScopeId !== null && scopeId === pres.activeScopeId;
}

/**
 * Short-lived de-dupe set over source message ids. A channel @mention fires both
 * `message.created` and `notification.created` for the SAME message id — the
 * first to pass marks it sounded; the second is skipped. Entries expire after
 * `windowMs` (default 1.5s) and the set is capped at `maxEntries` (default 50) so
 * it never grows unbounded.
 */
export class Deduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 1500,
    private readonly maxEntries = 50,
  ) {}

  /**
   * Returns true the FIRST time `id` is presented within the window (caller should
   * proceed to sound), false on a repeat (caller should skip). `now` is injectable
   * for tests.
   */
  shouldSound(id: string, now: number = Date.now()): boolean {
    this.prune(now);
    const at = this.seen.get(id);
    if (at !== undefined && now - at < this.windowMs) return false;
    this.seen.set(id, now);
    if (this.seen.size > this.maxEntries) {
      // Drop the oldest insertion (Map preserves insertion order).
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private prune(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at >= this.windowMs) this.seen.delete(id);
    }
  }
}

/**
 * Compute the total out-of-app unread count = unread messages across all
 * read-marker scopes + unseen mention/reply notifications. Pure: the caller
 * passes the already-summed read-marker total and the two notification counts.
 */
export function computeTotalUnread(
  readMarkerTotal: number,
  unseenMentions: number,
  unseenReplies: number,
): number {
  return Math.max(0, readMarkerTotal) + Math.max(0, unseenMentions) + Math.max(0, unseenReplies);
}

/** Format the total for the tab title: capped at "99+". */
export function badgeLabel(total: number): string {
  return total > 99 ? "99+" : String(total);
}
