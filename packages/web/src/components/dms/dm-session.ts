/**
 * One open DM conversation in a view (`DmsPage` starts one per conversation and
 * disposes it on a switch or unmount): {@link startOpenSession} over
 * {@link openConversation}. See `components/shared/open-session.ts` for the
 * lifetime: `dispose()` closes the conversation at once, even while its inbox
 * page is still loading, so on A → B → A the first open of A has let go of A's
 * thread and timeline head before the second one starts.
 */
import {
  type OpenSession,
  type OpenSessionEvents,
  startOpenSession,
} from "../shared/open-session.ts";
import {
  type ConversationHandle,
  type OpenConversationDeps,
  openConversation,
} from "./dm-controller.ts";

export type DmSession = OpenSession;
export type DmSessionEvents = OpenSessionEvents<ConversationHandle>;

/**
 * Open `deps.dmId` for a view. Neither event fires after `dispose()`: a
 * disposed session's open ends quietly.
 */
export function startDmSession(
  deps: Omit<OpenConversationDeps, "signal">,
  events: DmSessionEvents,
): DmSession {
  return startOpenSession((signal) => openConversation({ ...deps, signal }), events);
}
