/**
 * One open timeline (a channel or a DM conversation) in a view, from the moment
 * the view asks for it until the view moves on. `ChatView` starts one per
 * channel and `DmsPage` one per conversation; each disposes it on a switch or
 * unmount.
 *
 * The session owns the timeline's lifetime signal, so `dispose()` ends it at
 * once, even while the open is still loading and there is no handle to close
 * yet. The controller's `open` takes the signal and closes itself when it
 * aborts: the listeners come off, the REST loads are aborted, and nothing the
 * old open was loading is written to the stores afterwards. That is what lets
 * a later open of the SAME scope (A → B → A) own the scope's state alone: the
 * cancelled open has finished touching it before the new one starts. Loads the
 * view starts later for the same timeline take {@link OpenSession.signal} so
 * they end with it too.
 */

/** What a controller's open resolves to: something that can be closed. */
export interface Closable {
  close(): void;
}

export interface OpenSession {
  /** Aborted by {@link OpenSession.dispose}; pass it to this timeline's other loads. */
  readonly signal: AbortSignal;
  /** End the timeline: closes it whether or not it has finished opening. Idempotent. */
  dispose(): void;
}

export interface OpenSessionEvents<H> {
  /** The timeline is open and not yet disposed. */
  opened(handle: H): void;
  /** Opening failed for a reason other than the session being disposed. */
  failed(message: string): void;
}

/**
 * Run `open(signal)` for a view. `open` must close what it opened when `signal`
 * aborts, and reject if it aborts before it is open. Neither event fires after
 * `dispose()`: a disposed session's open ends quietly.
 */
export function startOpenSession<H extends Closable>(
  open: (signal: AbortSignal) => Promise<H>,
  events: OpenSessionEvents<H>,
): OpenSession {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  open(signal).then(
    (handle) => {
      // `open` closes the handle itself when `signal` aborts; one that resolved
      // in the same turn as the abort is closed here as well.
      if (signal.aborted) handle.close();
      else events.opened(handle);
    },
    (err: unknown) => {
      if (signal.aborted) return;
      events.failed(err instanceof Error ? err.message : String(err));
    },
  );
  return {
    signal,
    dispose: () => lifetime.abort(),
  };
}

/** The caller's abort reason, when its signal is what ended the open. */
export function closedReason(callerSignal: AbortSignal | undefined): unknown {
  return callerSignal?.aborted ? callerSignal.reason : undefined;
}

/** The rejection of an open ended by its own `close()` before it resolved. */
export function closedError(what: string): DOMException {
  return new DOMException(`The ${what} was closed while it was opening`, "AbortError");
}
