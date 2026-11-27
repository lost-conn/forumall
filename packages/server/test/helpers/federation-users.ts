/**
 * Identities, signed HTTP and WebSocket sessions against either provider of a
 * {@link startFederation} harness: register a user with a device key on a
 * provider, send user-signed requests to any provider (signed for THAT
 * provider's authority, so a remote actor's request verifies through the
 * keys endpoint, §4.6), and open an authenticated WS to any provider — the
 * direct-WS connection of §8.5 when the actor is remote there.
 */
import { expect } from "bun:test";
import {
  type AuthBootstrapResponse,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
} from "@forumall/shared";

import type { Provider } from "./two-provider.ts";
import { WsClient } from "./ws-harness.ts";

/** A registered user and the device key it signs with. */
export interface FedUser {
  readonly actor: string;
  readonly keyId: string;
  readonly privateKey: string;
}

/** Register `handle` on `p` and add an Ed25519 device key. */
export async function registerOn(p: Provider, handle: string): Promise<FedUser> {
  const reg = await p.app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const { bootstrap_token } = (await reg.json()) as AuthBootstrapResponse;
  const keypair = generateKeyPair();
  const dk = await p.app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bootstrap_token}` },
    body: JSON.stringify({
      public_key: keypair.publicKey,
      algorithm: "Ed25519",
      device_name: "dev",
    }),
  });
  expect(dk.status).toBe(201);
  const { key_id } = (await dk.json()) as { key_id: string };
  return { actor: `${handle}@${p.domain}`, keyId: key_id, privateKey: keypair.privateKey };
}

/**
 * Send a request signed by `user` to provider `p` (over its real server).
 * `target` may carry a query string, signed as its own line (§4.4.2).
 */
export function signedTo(
  p: Provider,
  user: FedUser,
  method: string,
  target: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const q = target.indexOf("?");
  const { headers } = sign({
    actor: user.actor,
    keyId: user.keyId,
    privateKey: user.privateKey,
    authority: p.domain,
    method,
    path: q === -1 ? target : target.slice(0, q),
    ...(q === -1 ? {} : { query: target.slice(q + 1) }),
    ...(body !== undefined ? { body } : {}),
  });
  return fetch(`${p.base}${target}`, {
    method,
    headers: {
      ...headers,
      host: p.domain,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

/** Open a WS to `p` and complete the §7.1 handshake as `user`, binding `p`'s authority. */
export async function connectTo(p: Provider, user: FedUser): Promise<WsClient> {
  const client = await WsClient.open(`ws://localhost:${p.server.port}/api/ws`);
  const challenge = await client.ofType("auth.challenge");
  const nonce = (challenge.data as { nonce: string }).nonce;
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: user.privateKey,
    authority: p.domain,
    challengeNonce: nonce,
    timestamp,
  });
  client.send({
    id: "auth",
    type: "authenticate",
    data: { actor: user.actor, keyId: user.keyId, timestamp, signature },
  });
  await client.ofType("authenticated");
  return client;
}
