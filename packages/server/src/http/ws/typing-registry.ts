/**
 * Who is typing where: the active `typing.start`s of each actor in each scope —
 * a channel (§7.1 "Typing indicators") or a DM conversation by its `dmId`
 * (§7.4, "the same auto-expiry and disconnect rules as §7.1") — across all of
 * the actor's connections here. `WsCtx` holds one registry for each.
 *
 * Typing is the **actor's** state, as `channel.typing { user }` / `dm.typing
 * { user }` shows it: an actor has an active start in a scope while any of its
 * connections has an unexpired `typing.start` there. So:
 *
 *  - a `typing.start` (re)arms that connection's auto-expiry timer;
 *  - a `typing.stop` from any of the actor's connections ends the actor's
 *    start in the scope (every connection's timer), and is a no-op — nothing
 *    sent — when the actor has none (§7.1, §7.4);
 *  - a connection's timer expiring, or the connection closing, drops only that
 *    connection's start; the actor stops typing (and a `stop` is due) only
 *    when no other connection of theirs still holds one.
 *
 * Ephemeral, in-memory, never persisted (single-process, like the hub).
 */

/** A connection's identity in the registry (its `ConnState`). */
export type TypingConnection = object;

type Timer = ReturnType<typeof setTimeout>;

/** One actor's active starts in one scope: each typing connection's timer. */
type Starts = Map<TypingConnection, Timer>;

/** The registry key of an actor in a scope (`\n` cannot occur in either). */
function keyOf(actor: string, scopeId: string): string {
  return `${actor}\n${scopeId}`;
}

export class TypingRegistry {
  /** `actor + scope → connection → timer`, for the actors typing now. */
  private readonly starts = new Map<string, Starts>();
  /** `connection → the scopes it holds a start in` (for teardown). */
  private readonly byConnection = new Map<TypingConnection, Set<string>>();

  /**
   * Record `conn`'s `typing.start` by `actor` in `scopeId`, replacing its
   * previous timer there (a refresh). When the timer fires after `timeoutMs`
   * the start is dropped, and `onStopped` runs if that ended the actor's
   * typing in the scope (no other connection of theirs still types there).
   */
  start(
    conn: TypingConnection,
    actor: string,
    scopeId: string,
    timeoutMs: number,
    onStopped: () => void,
  ): void {
    const key = keyOf(actor, scopeId);
    let starts = this.starts.get(key);
    if (!starts) {
      starts = new Map();
      this.starts.set(key, starts);
    }
    const previous = starts.get(conn);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.drop(conn, actor, scopeId)) onStopped();
    }, timeoutMs);
    starts.set(conn, timer);
    let scopes = this.byConnection.get(conn);
    if (!scopes) {
      scopes = new Set();
      this.byConnection.set(conn, scopes);
    }
    scopes.add(scopeId);
  }

  /** Does `actor` have an active start in `scopeId` on any connection? */
  isTyping(actor: string, scopeId: string): boolean {
    return this.starts.has(keyOf(actor, scopeId));
  }

  /**
   * End `actor`'s typing in `scopeId` on every connection (a `typing.stop`).
   * Returns whether there was an active start to end; `false` means the stop
   * is a no-op.
   */
  stop(actor: string, scopeId: string): boolean {
    const key = keyOf(actor, scopeId);
    const starts = this.starts.get(key);
    if (!starts) return false;
    for (const [conn, timer] of starts) {
      clearTimeout(timer);
      this.forgetChannel(conn, scopeId);
    }
    this.starts.delete(key);
    return true;
  }

  /**
   * Drop every start `conn` (authenticated as `actor`) holds, as it closes.
   * Returns the scopes in which that ended the actor's typing, each of which
   * is due a `stop`.
   */
  dropConnection(conn: TypingConnection, actor: string): string[] {
    const scopes = [...(this.byConnection.get(conn) ?? [])];
    return scopes.filter((scopeId) => this.drop(conn, actor, scopeId));
  }

  /**
   * Drop `conn`'s start in `scopeId`. Returns whether the actor no longer
   * types there (it was the last connection holding a start).
   */
  private drop(conn: TypingConnection, actor: string, scopeId: string): boolean {
    const key = keyOf(actor, scopeId);
    const starts = this.starts.get(key);
    const timer = starts?.get(conn);
    if (!starts || timer === undefined) return false;
    clearTimeout(timer);
    starts.delete(conn);
    this.forgetChannel(conn, scopeId);
    if (starts.size > 0) return false;
    this.starts.delete(key);
    return true;
  }

  /** Remove `scopeId` from `conn`'s index entry. */
  private forgetChannel(conn: TypingConnection, scopeId: string): void {
    const scopes = this.byConnection.get(conn);
    if (!scopes) return;
    scopes.delete(scopeId);
    if (scopes.size === 0) this.byConnection.delete(conn);
  }
}
