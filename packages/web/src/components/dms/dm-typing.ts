/** DM typing signals over the WebSocket: the `dmId` is the target `channelId` (§7.4). */
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";

/** Throttle window for `typing.start` re-emits while composing (ms). */
export const DM_TYPING_THROTTLE_MS = 2500;
/** Idle window after the last keystroke before emitting `typing.stop` (ms). */
export const DM_TYPING_IDLE_MS = 3000;

/**
 * Signal the caller started typing in a DM. Typing is a live signal, so it is
 * dropped, never queued, while the connection is not authenticated (§7.1).
 */
export function dmTypingStart(ws: OfscpWsClient, dmId: string): void {
  ws.send("typing.start", { channelId: dmId }, { whenDisconnected: "drop" });
}

/** Signal the caller stopped typing in a DM (dropped while disconnected, as above). */
export function dmTypingStop(ws: OfscpWsClient, dmId: string): void {
  ws.send("typing.stop", { channelId: dmId }, { whenDisconnected: "drop" });
}
