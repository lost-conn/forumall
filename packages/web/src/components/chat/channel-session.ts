/**
 * One open channel in a view, from the moment the view asks for it until the
 * view moves on (`ChatView` starts one per channel and disposes it on a channel
 * switch or unmount).
 *
 * The session owns the channel's lifetime signal, so `dispose()` ends the
 * channel at once, even while {@link openChannel} is still loading history or
 * backfilling reactions and there is no handle to close yet: the listeners come
 * off, the REST loads are aborted, and nothing the old channel was loading is
 * written to the store afterwards. Loads the view starts later for the same
 * channel (a reply listing) take {@link ChannelSession.signal} so they end with
 * it too.
 */
import { type ChannelHandle, type OpenChannelDeps, openChannel } from "./chat-controller.ts";

export interface ChannelSession {
  /** Aborted by {@link ChannelSession.dispose}; pass it to this channel's other loads. */
  readonly signal: AbortSignal;
  /** End the channel: closes it whether or not it has finished opening. Idempotent. */
  dispose(): void;
}

export interface ChannelSessionEvents {
  /** The channel is open (history and its reactions loaded) and not yet disposed. */
  opened(handle: ChannelHandle): void;
  /** Opening failed for a reason other than the session being disposed. */
  failed(message: string): void;
}

/**
 * Open `deps.channelId` for a view. Neither event fires after `dispose()`: a
 * disposed session's open ends quietly.
 */
export function startChannelSession(
  deps: Omit<OpenChannelDeps, "signal">,
  events: ChannelSessionEvents,
): ChannelSession {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  openChannel({ ...deps, signal }).then(
    (handle) => {
      // `openChannel` closes the handle itself when `signal` aborts; one that
      // resolved in the same turn as the abort is closed here as well.
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
