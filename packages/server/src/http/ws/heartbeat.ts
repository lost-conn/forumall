/**
 * §7.1 *Heartbeat & liveness*: the client's `ping` and `pong` commands. The
 * provider's own `ping` and the idle close (`1000`) live on the connection's
 * heartbeat timer in `http/ws.ts`. Any inbound frame refreshes liveness there,
 * before dispatch, so a `pong` needs no further handling once it validates.
 */
import { WsPingSchema, WsPongSchema } from "@forumall/shared";
import type { ConnState, WsContext, WsCtx } from "./connection.ts";
import { errorEvent } from "./connection.ts";

/** `ping` → `pong` echoing the ping's `id` in `correlationId`. */
export function handlePing(
  ctx: WsCtx,
  ws: WsContext,
  _state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  if (!WsPingSchema.safeParse(rawFrame).success) {
    ctx.hub.send(ws, errorEvent("bad_request", "malformed ping command", frameId));
    return;
  }
  ctx.hub.send(ws, { type: "pong", correlationId: frameId, data: {} });
}

/** `pong`: the reply to our `ping`; liveness was already refreshed. */
export function handlePong(
  ctx: WsCtx,
  ws: WsContext,
  _state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  if (!WsPongSchema.safeParse(rawFrame).success) {
    ctx.hub.send(ws, errorEvent("bad_request", "malformed pong command", frameId));
  }
}
