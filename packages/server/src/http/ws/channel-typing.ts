/**
 * Who is typing where (§7.1 "Typing indicators"): the active `typing.start`s
 * of each actor in each channel, across all of the actor's connections here.
 *
 * Typing is the **actor's** state, as `channel.typing { user }` shows it: an
 * actor has an active start in a channel while any of its connections has an
 * unexpired `typing.start` there. So:
 *
 *  - a `typing.start` (re)arms that connection's auto-expiry timer;
 *  - a `typing.stop` from any of the actor's connections ends the actor's
 *    start in the channel (every connection's timer), and is a no-op — nothing
 *    sent — when the actor has none (§7.1);
 *  - a connection's timer expiring, or the connection closing, drops only that
 *    connection's start; the actor stops typing (and a `stop` is due) only
 *    when no other connection of theirs still holds one.
 *
 * Ephemeral, in-memory, never persisted (single-process, like the hub). DM
 * typing (§7.4) is kept per connection in `ConnState.dmTypingTimers`.
 */

/** A connection's identity in the registry (its `ConnState`). */
export type TypingConnection = object;

type Timer = ReturnType<typeof setTimeout>;

/** One actor's active starts in one channel: each typing connection's timer. */
type Starts = Map<TypingConnection, Timer>;

/** The registry key of an actor in a channel (`\n` cannot occur in either). */
function keyOf(actor: string, channelId: string): string {
  return `${actor}\n${channelId}`;
}

export class ChannelTypingRegistry {
  /** `actor + channel → connection → timer`, for the actors typing now. */
  private readonly starts = new Map<string, Starts>();
  /** `connection → the channels it holds a start in` (for teardown). */
  private readonly byConnection = new Map<TypingConnection, Set<string>>();

  /**
   * Record `conn`'s `typing.start` by `actor` in `channelId`, replacing its
   * previous timer there (a refresh). When the timer fires after `timeoutMs`
   * the start is dropped, and `onStopped` runs if that ended the actor's
   * typing in the channel (no other connection of theirs still types there).
   */
  start(
    conn: TypingConnection,
    actor: string,
    channelId: string,
    timeoutMs: number,
    onStopped: () => void,
  ): void {
    const key = keyOf(actor, channelId);
    let starts = this.starts.get(key);
    if (!starts) {
      starts = new Map();
      this.starts.set(key, starts);
    }
    const previous = starts.get(conn);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.drop(conn, actor, channelId)) onStopped();
    }, timeoutMs);
    starts.set(conn, timer);
    let channels = this.byConnection.get(conn);
    if (!channels) {
      channels = new Set();
      this.byConnection.set(conn, channels);
    }
    channels.add(channelId);
  }

  /** Does `actor` have an active start in `channelId` on any connection? */
  isTyping(actor: string, channelId: string): boolean {
    return this.starts.has(keyOf(actor, channelId));
  }

  /**
   * End `actor`'s typing in `channelId` on every connection (a `typing.stop`).
   * Returns whether there was an active start to end; `false` means the stop
   * is a no-op.
   */
  stop(actor: string, channelId: string): boolean {
    const key = keyOf(actor, channelId);
    const starts = this.starts.get(key);
    if (!starts) return false;
    for (const [conn, timer] of starts) {
      clearTimeout(timer);
      this.forgetChannel(conn, channelId);
    }
    this.starts.delete(key);
    return true;
  }

  /**
   * Drop every start `conn` (authenticated as `actor`) holds, as it closes.
   * Returns the channels in which that ended the actor's typing, each of which
   * is due a `stop`.
   */
  dropConnection(conn: TypingConnection, actor: string): string[] {
    const channels = [...(this.byConnection.get(conn) ?? [])];
    return channels.filter((channelId) => this.drop(conn, actor, channelId));
  }

  /**
   * Drop `conn`'s start in `channelId`. Returns whether the actor no longer
   * types there (it was the last connection holding a start).
   */
  private drop(conn: TypingConnection, actor: string, channelId: string): boolean {
    const key = keyOf(actor, channelId);
    const starts = this.starts.get(key);
    const timer = starts?.get(conn);
    if (!starts || timer === undefined) return false;
    clearTimeout(timer);
    starts.delete(conn);
    this.forgetChannel(conn, channelId);
    if (starts.size > 0) return false;
    this.starts.delete(key);
    return true;
  }

  /** Remove `channelId` from `conn`'s index entry. */
  private forgetChannel(conn: TypingConnection, channelId: string): void {
    const channels = this.byConnection.get(conn);
    if (!channels) return;
    channels.delete(channelId);
    if (channels.size === 0) this.byConnection.delete(conn);
  }
}
