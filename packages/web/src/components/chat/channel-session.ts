/**
 * One open channel in a view (`ChatView` starts one per channel and disposes it
 * on a channel switch or unmount): {@link startOpenSession} over
 * {@link openChannel}. See `components/shared/open-session.ts` for the
 * lifetime: `dispose()` ends the channel at once, even while it is still
 * loading history or backfilling reactions, and nothing it was loading is
 * written to the store afterwards. Loads the view starts later for the same
 * channel (a reply listing) take {@link ChannelSession.signal}.
 */
import {
  type OpenSession,
  type OpenSessionEvents,
  startOpenSession,
} from "../shared/open-session.ts";
import { type ChannelHandle, type OpenChannelDeps, openChannel } from "./chat-controller.ts";

export type ChannelSession = OpenSession;
export type ChannelSessionEvents = OpenSessionEvents<ChannelHandle>;

/**
 * Open `deps.channelId` for a view. Neither event fires after `dispose()`: a
 * disposed session's open ends quietly.
 */
export function startChannelSession(
  deps: Omit<OpenChannelDeps, "signal">,
  events: ChannelSessionEvents,
): ChannelSession {
  return startOpenSession((signal) => openChannel({ ...deps, signal }), events);
}
