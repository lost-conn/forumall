/**
 * §7.1 + §8.5 `authenticate`: verify the signed challenge, resolve the device
 * key (locally, or from a remote actor's home provider), burn the challenge in
 * the provider-wide replay store and register the connection in the hub.
 */
import {
  WsAuthenticateSchema,
  canonicalAuthority,
  isCanonicalActor,
  verifyWsAuthenticate,
} from "@forumall/shared";
import { resolveActorKeys } from "../../provider/device-keys.ts";
import type { KeyLookup } from "../../provider/federation/key-lookup.ts";
import { isProviderAllowed } from "../../provider/federation/policy.ts";
import type { RemoteActorKey } from "../../provider/federation/user-keys-cache.ts";
import { nonceKeyId, nonceRetentionMs } from "../../provider/nonce-store.ts";
import { fanOutPresence } from "../../provider/presence.ts";
import type { HubConnection, HubSocket } from "../../provider/ws-hub.ts";
import {
  type ConnState,
  TIMESTAMP_SKEW_SECONDS,
  WS_CLOSE_AUTH_FAILED,
  type WsContext,
  type WsCtx,
  errorEvent,
  rawSocket,
  terminate,
} from "./connection.ts";
import { startRemoteKeyWatch } from "./remote-key-watch.ts";

/**
 * §7.1 + §8.5 Authentication: verify the signed challenge and register the
 * connection.
 *
 * ## Local vs remote key resolution (§8.5 step 3)
 * The `authenticate` canonical string binds the **home provider being connected
 * to** — i.e. THIS provider's `config.domain` (`authority`) — regardless of the
 * actor's origin (§8.5). Key resolution splits on the actor's home domain:
 *  - **Local** actor (`handle@<this host>`) → {@link resolveActorKeys} as before.
 *  - **Remote** actor (a different home provider) → resolve the device key from
 *    the actor's home provider via {@link RemoteUserKeysCache} (§4.6); on a
 *    verify miss for a key believed valid, force one cache re-fetch and retry,
 *    so rotation/revocation is picked up promptly (§4.6, §8.5 step 3).
 *
 * ## Connect-time federation policy (§8.5 connection notes)
 * For a remote actor the §8 allow/deny policy ({@link isProviderAllowed}) is
 * applied at the handshake BEFORE any key fetch; a disallowed peer gets an
 * `error` then close 4001. Local actors are unaffected.
 *
 * ## Guests (§4.8)
 * Guest accounts are NOT federated and MUST NOT open a remote WS connection. In
 * this implementation guests are provider-LOCAL only (provisioned via invites,
 * §5.6/§4.8) — there is no notion of a remote guest, and the §4.6 keys-response
 * carries no guest flag, so a *remote* actor reaching this path can never be a
 * local guest. We therefore cannot cheaply detect (and so do not separately
 * refuse) a remote actor that is flagged guest at its home provider; that
 * refusal is the remote provider's MAY per §4.8. A local guest authenticating
 * here is a normal local actor and is allowed (the WS is to its own home).
 */
export async function handleAuthenticate(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): Promise<void> {
  const { config, db, hub, presenceRegistry, userKeysCache, nonceStore, authority } = ctx;
  const fail = (message: string): void => {
    hub.send(ws, errorEvent("unauthorized", message, frameId));
    ws.close(WS_CLOSE_AUTH_FAILED, "authentication failed");
  };

  const parsed = WsAuthenticateSchema.safeParse(rawFrame);
  if (!parsed.success) {
    fail("malformed authenticate command");
    return;
  }
  const { actor, keyId, timestamp, signature } = parsed.data.data;

  // §2.2: the `authenticate` actor MUST be canonical. Rejected (error + close
  // 4001), never converted, so the connection's identity — hub routing,
  // presence, policy, storage — has exactly one spelling.
  if (!isCanonicalActor(actor)) {
    fail("authenticate actor must be in canonical form (OFSCP §2.2)");
    return;
  }

  // §4.5 step 3: timestamp within ±skew.
  const tsMillis = Date.parse(timestamp);
  if (
    Number.isNaN(tsMillis) ||
    Math.abs(nonceStore.now() - tsMillis) > TIMESTAMP_SKEW_SECONDS * 1000
  ) {
    fail("authenticate timestamp is outside the allowed window");
    return;
  }

  // The challenge MUST be the one we issued for THIS connection, unused +
  // unexpired (§7.1 step 3). We bind to a single per-connection nonce, so we
  // only ever compare against `state.challengeNonce`.
  if (state.challengeUsed) {
    fail("challenge nonce already used");
    return;
  }
  if (nonceStore.now() > state.challengeExpiresAt) {
    fail("challenge nonce expired");
    return;
  }

  // Provider-wide replay guard (#21): the SAME store the REST signature
  // middleware uses. `state.challengeUsed` above only catches reuse on THIS
  // connection object; this additionally catches a `(key_id, nonce)` pair
  // already burned by another connection (e.g. a colliding/replayed
  // challenge nonce) or by a REST request. Namespaced "actor" — WS only ever
  // authenticates a user device key (§4.4), never a provider identity
  // (§8.1). Recorded only once the signature verifies (below), mirroring the
  // REST middleware, so failed handshakes never fill the store; a failed
  // attempt still ends this connection, whose challenge is single-use.
  const nsKeyId = nonceKeyId("actor", keyId);
  if (nonceStore.has(nsKeyId, state.challengeNonce)) {
    fail("challenge nonce already used");
    return;
  }

  // Parse the actor identity (§4.5 step 6 split).
  const at = actor.lastIndexOf("@");
  if (at <= 0 || at === actor.length - 1) {
    fail("malformed actor");
    return;
  }
  const handle = actor.slice(0, at);
  const actorDomain = canonicalAuthority(actor.slice(at + 1));

  // The signature is always bound to THIS provider's authority (the home
  // provider being connected to, §8.5) — never the actor's own domain.
  const verifyWith = (publicKey: string): boolean =>
    verifyWsAuthenticate({
      publicKey,
      authority,
      challengeNonce: state.challengeNonce,
      timestamp,
      signature,
    });

  // A remote actor's verifying lookup: what keeps the connection's key
  // confirmed afterwards (§7.1 "Close codes", `remote-key-watch.ts`).
  let remoteKey: Extract<KeyLookup<RemoteActorKey>, { kind: "found" }> | undefined;
  if (actorDomain === authority) {
    // --- Local actor: resolve a device key locally (§4.5 step 6) -----------
    const key = resolveActorKeys(db, handle).find((k) => k.keyId === keyId);
    if (!key) {
      fail("no active device key matches actor/keyId");
      return;
    }
    if (!verifyWith(key.publicKey)) {
      fail("invalid authenticate signature");
      return;
    }
  } else {
    // --- Remote actor (§8.5 step 3) ----------------------------------------
    // Connect-time federation policy (§8.5 connection notes): a disallowed peer
    // is rejected BEFORE any key fetch.
    if (!isProviderAllowed(config, actorDomain)) {
      fail(`federation with ${actorDomain} is not permitted by this provider's policy`);
      return;
    }

    // Resolve the actor's published device key from its home provider (§4.6),
    // verifying against it. The cache re-fetches when the key id is absent;
    // a CACHED key that fails to verify forces one re-fetch (rotation),
    // mirroring the HTTP signature path (signer-resolution.ts).
    let lookup = await userKeysCache.lookupActorKey(actor, keyId);
    if (lookup.kind === "found" && !lookup.fresh && !verifyWith(lookup.key.publicKey)) {
      lookup = await userKeysCache.lookupActorKey(actor, keyId, { forceRefresh: true });
    }
    if (lookup.kind !== "found") {
      fail(`remote device key not resolved (${lookup.kind.replace("_", " ")})`);
      return;
    }
    if (!verifyWith(lookup.key.publicKey)) {
      fail("invalid authenticate signature");
      return;
    }
    remoteKey = lookup;
  }

  // A late frame may have raced the async key resolution and already closed /
  // re-authenticated this connection; bail if so (don't double-register).
  if (state.authenticated || state.challengeUsed) {
    return;
  }

  // Verified: burn the pair provider-wide (re-check — another connection may
  // have verified the same pair while we awaited key resolution).
  if (
    nonceStore.has(nsKeyId, state.challengeNonce) ||
    !nonceStore.remember(nsKeyId, state.challengeNonce, nonceRetentionMs(TIMESTAMP_SKEW_SECONDS))
  ) {
    fail("challenge nonce already used");
    return;
  }

  // Success: consume the challenge, mark authenticated, register in the hub.
  state.challengeUsed = true;
  state.authenticated = true;
  state.actor = actor;
  // Only a LOCAL actor gets a local handle; a remote actor's `handle` names a
  // user of `actorDomain`, never of this provider (see ConnState.localHandle).
  if (actorDomain === authority) state.localHandle = handle;
  state.keyId = keyId;
  if (remoteKey) startRemoteKeyWatch(ctx, ws, state, actorDomain, remoteKey);
  if (state.authTimer) {
    clearTimeout(state.authTimer);
    state.authTimer = undefined;
  }
  // Store the STABLE socket (`ws.raw`) for cross-event fan-out, not the
  // per-event WSContext.
  const socket: HubSocket = rawSocket(ws) ?? ws;
  const hubConn: HubConnection = {
    socket,
    actor,
    subscriptions: new Set(),
    keyId,
    ...(state.localHandle !== undefined ? { localHandle: state.localHandle } : {}),
    // Lets the hub end this session when its credentials are revoked (#15).
    terminate: (code, reason) => terminate(ctx, ws, state, code, reason),
  };
  state.hubConn = hubConn;
  // Whether the actor had NO live connection before this one (→ this auth flips
  // them online). Checked BEFORE `hub.add` so the prior count excludes us.
  const wasOffline = hub.liveConnectionCount(actor) === 0;
  hub.add(hubConn);

  hub.send(ws, { type: "authenticated", correlationId: frameId, data: { actor } });

  // §7.5 connection-derived online: the actor's first live connection flips
  // them effectively online (their explicit away/dnd, if any, is preserved by
  // `effectivePresence` reading the stored value) and fans out a
  // `presence.update` to subscribers. A second/third device does not re-fan
  // (they were already online).
  // Local actors only — see the note on ConnState.localHandle.
  if (wasOffline && state.localHandle !== undefined) {
    fanOutPresence(db, hub, config, presenceRegistry, state.localHandle);
  }
}
