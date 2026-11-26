/**
 * §7.5 presence commands: `presence.subscribe` (with the per-viewer initial
 * snapshot), `presence.unsubscribe` and `presence.set`.
 */
import {
  WsPresenceSetSchema,
  WsPresenceSubscribeSchema,
  WsPresenceSubscribedSchema,
  WsPresenceUnsubscribeSchema,
  WsPresenceUnsubscribedSchema,
  canonicalActor,
  canonicalAuthority,
} from "@forumall/shared";
import {
  fanOutPresence,
  presenceForSubject,
  presenceUpdateEvent,
  setExplicitPresence,
  toPresence,
} from "../../provider/presence.ts";
import { localHandleOfUserRef } from "../../provider/user-refs.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/**
 * §7.5 presence.subscribe: register this connection as a subscriber of each
 * named user's presence (connection-scoped, like channel subscriptions), ack
 * with `presence.subscribed`, then IMMEDIATELY send an initial `presence.update`
 * snapshot for each subscribed user — filtered for THIS viewer exactly as
 * `GET /api/users/{ref}/presence` would be (so the two surfaces agree).
 *
 * ## Refused subjects (§7.5, parallel to channel `subscribe` §7.1)
 * A provider only hosts presence for its own users. A listed user it does not
 * host, or an unknown local handle — exactly the subjects
 * `GET /api/users/{userRef}/presence` answers `404` ({@link localHandleOfUserRef})
 * — is left out of `presence.subscribed` and gets no updates. The rest are
 * subscribed and acked with `presence.subscribed` listing only them; then ONE
 * `error` (`not_found`, the refused refs as given in `details.users`) covers
 * every refused one. With no subject left, only the `error` is sent.
 * Subscribed subjects are keyed by their canonical local actor
 * (`handle@<this authority>`), the key the fan-out publishes under.
 */
export function handlePresenceSubscribe(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { config, db, hub, presenceRegistry, authority } = ctx;
  const parsed = WsPresenceSubscribeSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed presence.subscribe command", frameId));
    return;
  }
  const hubConn = state.hubConn;
  if (!hubConn) return; // unreachable: only authenticated connections reach here

  // Split hosted subjects from refused ones. Each listed ref once, in order.
  const subjects: string[] = [];
  const refused: string[] = [];
  for (const ref of new Set(parsed.data.data.users)) {
    const handle = localHandleOfUserRef(db, authority, ref);
    if (handle === null) {
      refused.push(ref);
    } else {
      const subject = `${handle}@${authority}`;
      if (!subjects.includes(subject)) subjects.push(subject);
    }
  }
  const refusal = (): void => {
    if (refused.length === 0) return;
    hub.send(ws, errorEvent("not_found", "No such user", frameId, { users: refused }));
  };
  if (subjects.length === 0) {
    refusal();
    return;
  }
  presenceRegistry.subscribe(hubConn, subjects);

  // Ack first, then the refusal, then the per-user snapshot (§7.5).
  hub.send(ws, {
    type: "presence.subscribed",
    correlationId: frameId,
    data: WsPresenceSubscribedSchema.shape.data.parse({ users: subjects }),
  });
  refusal();

  // `canView` matches SELF on the full actor; `handle` is the viewer's LOCAL
  // handle (empty for a remote viewer), never a foreign handle passed off as one.
  const viewer = {
    actor: state.actor as string,
    handle: state.localHandle ?? "",
    domain: state.actor !== undefined ? domainOfActor(state.actor) : authority,
  };
  for (const subject of subjects) {
    const eff = presenceForSubject(db, hub, config, subject, viewer);
    hub.send(ws, presenceUpdateEvent(subject, toPresence(eff)));
  }
}

/**
 * §7.5 presence.unsubscribe: drop this connection's subscription to each named
 * user's presence and ack `presence.unsubscribed`. No further updates flow for
 * those subjects until re-subscribed.
 */
export function handlePresenceUnsubscribe(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub, presenceRegistry, authority } = ctx;
  const parsed = WsPresenceUnsubscribeSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed presence.unsubscribe command", frameId));
    return;
  }
  const hubConn = state.hubConn;
  if (!hubConn) return;

  // Normalize to the same canonical actor key used at subscribe time: a hosted
  // user's local actor; any other ref keeps its own domain (§4.5.1), which
  // matches no subscription and is simply acked.
  const subjects = parsed.data.data.users.map((u) => {
    const handle = localHandleOfUserRef(db, authority, u);
    return handle === null ? canonicalSubjectActor(u, authority) : `${handle}@${authority}`;
  });
  presenceRegistry.unsubscribe(hubConn, subjects);
  hub.send(ws, {
    type: "presence.unsubscribed",
    correlationId: frameId,
    data: WsPresenceUnsubscribedSchema.shape.data.parse({ users: subjects }),
  });
}

/**
 * §7.5 presence.set: equivalent to `PUT /api/me/presence` — replace the caller's
 * stored EXPLICIT availability/status (the schema already rejects `offline` as a
 * set value) and fan out a privacy-filtered `presence.update` to subscribers.
 * The same stored value drives both surfaces (§7.5 reconciliation).
 */
export function handlePresenceSet(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { config, db, hub, presenceRegistry } = ctx;
  const parsed = WsPresenceSetSchema.safeParse(rawFrame);
  if (!parsed.success) {
    // A malformed frame OR an `offline` availability (not in the set enum) lands
    // here — both are rejected (§7.5: `offline` is not settable).
    hub.send(ws, errorEvent("bad_request", "malformed presence.set command", frameId));
    return;
  }
  // Stored presence is keyed on a LOCAL handle and a remote actor's presence is
  // owned by their home provider (§7.5/§8.5), so a remote connection may not set
  // it here — it would otherwise write the like-named local user's row.
  const handle = state.localHandle;
  if (handle === undefined) {
    hub.send(ws, errorEvent("forbidden", "presence is managed by your home provider", frameId));
    return;
  }

  // Full replace (§7.5): an absent `status` clears the stored one.
  const { availability, status } = parsed.data.data;
  setExplicitPresence(db, handle, availability, status ?? null);
  fanOutPresence(db, hub, config, presenceRegistry, handle);
}
/**
 * Canonicalize a `presence.subscribe`/`presence.unsubscribe` user ref to a full
 * `handle@domain` actor (§7.5). A bare handle (no `@`) is LOCAL to this
 * provider's namespace and defaults to `localAuthority`; a `handle@domain` ref
 * keeps its OWN domain (canonicalized) — it is NEVER rewritten onto
 * `localAuthority`. This is the only place a subject's domain is decided;
 * presence resolution downstream ({@link presenceForSubject}) refuses to treat
 * a non-local domain as ours, per §4.5.1 ("MUST NOT use the actor's bare handle
 * as a key into provider-local storage").
 */
function canonicalSubjectActor(ref: string, localAuthority: string): string {
  // §2.2: a `handle@domain` ref is converted to canonical form (handle + domain)
  // before it keys the presence registry or any visibility decision.
  return canonicalActor(ref) ?? `${ref}@${localAuthority}`;
}

/**
 * The canonicalized domain of an actor (`handle@domain`), or `""` if malformed.
 * Used to describe a viewer's own home domain — a WS connection may be from a
 * REMOTE actor (§8.5), so the connection's identity domain is not necessarily
 * this provider's authority.
 */
function domainOfActor(actor: string): string {
  const at = actor.lastIndexOf("@");
  return at > 0 && at < actor.length - 1 ? canonicalAuthority(actor.slice(at + 1)) : "";
}
