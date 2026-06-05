/**
 * Cross-provider real-time channel delivery (direct-WS) tests — spec §8.2, §8.5.
 *
 * Drives a real two-provider federation (`a.test` + `b.test`) via the
 * {@link startFederation} harness. User `alice` is hosted on provider A; provider
 * B hosts a group (`open` join policy) with a group-tier channel plus a local
 * user `bob`.
 *
 * The flow under test (§8.5):
 *  1. alice (remote) calls `POST /api/groups/{g}/channels/{c}/join` on B,
 *     user-signed → becomes a member of B's group (§8.2).
 *  2. alice opens a WebSocket straight to B (`ws://localhost:{B.port}/api/ws`),
 *     completes the signed-challenge handshake — B resolves alice's key from A
 *     via the user-keys cache and verifies — then subscribes to the channel.
 *  3. bob posts on B → alice receives `message.created` live over her direct WS.
 *  4. bob edits/deletes → alice receives `message.updated`/`message.deleted`.
 *
 * Plus the failure paths: an un-joined remote actor is rejected at subscribe
 * (`error` forbidden); a denied peer's handshake is rejected (error + close
 * 4001); a forged WS-auth signature closes 4001.
 *
 * The `authenticate` canonical string binds **B's** authority (the home provider
 * being connected to, §8.5), not alice's own domain.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type GeneratedKeyPair,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
} from "@forumall/shared";

import { createChannel } from "../src/provider/channels.ts";
import { createGroup } from "../src/provider/groups.ts";
import {
  type Federation,
  type Provider,
  type StartFederationOptions,
  startFederation,
} from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedrt-"));
});

const open: Federation[] = [];
const openClients: WsClient[] = [];
afterEach(() => {
  for (const c of openClients.splice(0)) c.close();
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedrt-"));
});

function boot(opts: StartFederationOptions = {}): Federation {
  const fed = startFederation(tmp, opts);
  open.push(fed);
  return fed;
}

// ---------------------------------------------------------------------------
// Identity + setup helpers
// ---------------------------------------------------------------------------

/** Register `handle` on provider A and add a device key; returns the keypair + id. */
async function registerAlice(
  fed: Federation,
  handle = "alice",
): Promise<{ keyId: string; keypair: GeneratedKeyPair }> {
  const reg = await fed.a.app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const { bootstrap_token } = (await reg.json()) as AuthBootstrapResponse;

  const keypair = generateKeyPair();
  const dk = await fed.a.app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bootstrap_token}` },
    body: JSON.stringify({
      public_key: keypair.publicKey,
      algorithm: "Ed25519",
      device_name: "alice-laptop",
    }),
  });
  expect(dk.status).toBe(201);
  const { key_id } = (await dk.json()) as { key_id: string };
  return { keyId: key_id, keypair };
}

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

/** Register `handle` locally on provider B and add a device key. */
async function registerBob(fed: Federation, handle = "bob"): Promise<Signer> {
  const reg = await fed.b.app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const { bootstrap_token } = (await reg.json()) as AuthBootstrapResponse;
  const keypair = generateKeyPair();
  const dk = await fed.b.app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bootstrap_token}` },
    body: JSON.stringify({
      public_key: keypair.publicKey,
      algorithm: "Ed25519",
      device_name: "bob-laptop",
    }),
  });
  expect(dk.status).toBe(201);
  const { key_id } = (await dk.json()) as { key_id: string };
  return { keyId: key_id, privateKey: keypair.privateKey, actor: `${handle}@${fed.b.domain}` };
}

/**
 * Create an `open`-join group on B with a `group`-tier channel. Returns ids. The
 * group is created directly via the provider helper (owner is a synthetic local
 * actor); the channel tier `group` requires membership, exercising the join.
 */
function makeGroupChannelOnB(fed: Federation): { groupId: string; channelId: string } {
  const group = createGroup(fed.b.db, `owner@${fed.b.domain}`, {
    name: "club",
    tier: "public",
    joinPolicy: "open",
  });
  const channel = createChannel(fed.b.db, group.id, {
    type: "text",
    name: "general",
    tier: "group",
  });
  return { groupId: group.id, channelId: channel.id };
}

/** Send a user-signed POST (no body) to B at `path`, signing for B's authority. */
function signedPostToB(
  fed: Federation,
  args: { actor: string; keyId: string; privateKey: string; path: string },
): Promise<Response> {
  const { headers } = sign({
    actor: args.actor,
    keyId: args.keyId,
    privateKey: args.privateKey,
    authority: fed.b.domain,
    method: "POST",
    path: args.path,
  });
  return fetch(`${fed.b.base}${args.path}`, {
    method: "POST",
    headers: { ...headers, host: fed.b.domain },
  });
}

// ---------------------------------------------------------------------------
// WS client (mirrors ws.test.ts) driving a raw socket to a provider's port.
// ---------------------------------------------------------------------------

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];
  closeCode: number | undefined;
  closed = false;
  private readonly closeWaiters: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = true;
      this.closeCode = e.code;
      for (const w of this.closeWaiters.splice(0)) w();
    });
  }

  static async open(url: string): Promise<WsClient> {
    const c = new WsClient(url);
    openClients.push(c);
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve(), { once: true });
      c.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    return c;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  next(pred: (f: WsEnvelope) => boolean = () => true, timeoutMs = 2000): Promise<WsEnvelope> {
    const queued = this.queue.findIndex(pred);
    if (queued !== -1) return Promise.resolve(this.queue.splice(queued, 1)[0] as WsEnvelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      const waiter = (f: WsEnvelope) => {
        if (!pred(f)) {
          this.queue.push(f);
          this.waiters.unshift(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push(waiter);
    });
  }

  ofType(type: string, timeoutMs = 2000): Promise<WsEnvelope> {
    return this.next((f) => f.type === type, timeoutMs);
  }

  waitClosed(timeoutMs = 2000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

/** `ws://localhost:{port}/api/ws` for a provider. */
function wsUrl(p: Provider): string {
  return `ws://localhost:${p.server.port}/api/ws`;
}

/** Connect to a provider's WS, read the `auth.challenge`, return the nonce. */
async function connectAndChallenge(p: Provider): Promise<{ client: WsClient; nonce: string }> {
  const client = await WsClient.open(wsUrl(p));
  const challenge = await client.ofType("auth.challenge");
  return { client, nonce: (challenge.data as { nonce: string }).nonce };
}

/**
 * Sign + send an `authenticate` over `nonce`, binding `authority` (the provider
 * being connected to — B's domain for a remote handshake). `signWith` overrides
 * the signing key to forge a bad signature.
 */
function sendAuthenticate(
  client: WsClient,
  args: { actor: string; keyId: string; privateKey: string; authority: string; signWith?: string },
): void {
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: args.signWith ?? args.privateKey,
    authority: args.authority,
    challengeNonce: nonceOf(client),
    timestamp,
  });
  client.send({
    id: "cli_auth_1",
    type: "authenticate",
    ts: rfc3339Timestamp(),
    data: { actor: args.actor, keyId: args.keyId, timestamp, signature },
  });
}

// `sendAuthenticate` needs the nonce; we stash it on the client to keep the
// signature ergonomic.
const nonces = new WeakMap<WsClient, string>();
function nonceOf(client: WsClient): string {
  const n = nonces.get(client);
  if (n === undefined) throw new Error("nonce not recorded for client");
  return n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-provider direct-WS channel delivery (§8.2, §8.5)", () => {
  test("alice joins B's channel, opens a direct WS to B, and receives bob's live message", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const alice = `alice@${fed.a.domain}`;
    const bob = await registerBob(fed);
    const { groupId, channelId } = makeGroupChannelOnB(fed);
    // bob is a local member so he can post.
    const { addMember } = await import("../src/provider/membership.ts");
    addMember(fed.b.db, groupId, bob.actor, "member");

    // 1. alice joins B's channel (§8.2) → member of B's group.
    const joinRes = await signedPostToB(fed, {
      actor: alice,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}/channels/${channelId}/join`,
    });
    expect(joinRes.status).toBe(201);
    const member = (await joinRes.json()) as { user: string; role: string };
    expect(member.user).toBe(alice);
    expect(member.role).toBe("member");
    // The keys endpoint on A was hit to verify alice's signed join.
    expect(fed.b.userKeysCache.fetchCount).toBeGreaterThanOrEqual(1);

    // 2. alice opens a direct WS to B and authenticates (B resolves her key from A).
    const { client, nonce } = await connectAndChallenge(fed.b);
    nonces.set(client, nonce);
    sendAuthenticate(client, {
      actor: alice,
      keyId,
      privateKey: keypair.privateKey,
      authority: fed.b.domain, // §8.5: bind the home provider being connected to.
    });
    const ack = await client.ofType("authenticated");
    expect((ack.data as { actor: string }).actor).toBe(alice);

    // 3. alice subscribes to the channel on B (member + tier → authorized).
    client.send({
      id: "cli_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    const sub = await client.ofType("subscribed");
    expect((sub.data as { channels: string[] }).channels).toEqual([channelId]);

    // 4. bob posts on B over his own WS → alice receives message.created live.
    const bobConn = await WsClient.open(wsUrl(fed.b));
    const bChallenge = await bobConn.ofType("auth.challenge");
    nonces.set(bobConn, (bChallenge.data as { nonce: string }).nonce);
    sendAuthenticate(bobConn, { ...bob, authority: fed.b.domain });
    await bobConn.ofType("authenticated");
    bobConn.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        clientMessageId: "cmsg_1",
        content: { mime: "text/plain", text: "hello federation" },
      },
    });

    const evt = await client.ofType("message.created");
    const msg = (evt.data as { message: { id: string; author: string; content: { text: string } } })
      .message;
    expect(msg.author).toBe(bob.actor);
    expect(msg.content.text).toBe("hello federation");

    // 5. bob edits then deletes → alice receives updated/deleted over the SAME WS.
    bobConn.send({
      id: "cli_edit",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        messageId: msg.id,
        content: { mime: "text/plain", text: "edited federation" },
      },
    });
    const upd = await client.ofType("message.updated");
    expect((upd.data as { message: { content: { text: string } } }).message.content.text).toBe(
      "edited federation",
    );

    bobConn.send({
      id: "cli_del",
      type: "message.delete",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId: msg.id },
    });
    const del = await client.ofType("message.deleted");
    expect((del.data as { messageId: string }).messageId).toBe(msg.id);

    client.close();
    bobConn.close();
  });

  test("a remote actor who has NOT joined → subscribe rejected with error forbidden", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const alice = `alice@${fed.a.domain}`;
    const { channelId } = makeGroupChannelOnB(fed);
    // alice does NOT join → not a member; the channel is `group`-tier (members only).

    const { client, nonce } = await connectAndChallenge(fed.b);
    nonces.set(client, nonce);
    sendAuthenticate(client, {
      actor: alice,
      keyId,
      privateKey: keypair.privateKey,
      authority: fed.b.domain,
    });
    await client.ofType("authenticated"); // authn succeeds; authz happens at subscribe.

    client.send({
      id: "cli_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    const err = await client.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);
    client.close();
  });

  test("federation policy: B denies a.test → alice's WS handshake rejected (error + close 4001)", async () => {
    const fed = boot({ envB: { FEDERATION_DENY: "a.test" } });
    const { keyId, keypair } = await registerAlice(fed);
    const alice = `alice@${fed.a.domain}`;

    const { client, nonce } = await connectAndChallenge(fed.b);
    nonces.set(client, nonce);
    sendAuthenticate(client, {
      actor: alice,
      keyId,
      privateKey: keypair.privateKey,
      authority: fed.b.domain,
    });
    const err = await client.ofType("error");
    expect((err.data as { status: number }).status).toBe(401);
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
    // Policy short-circuited BEFORE any key fetch.
    expect(fed.b.userKeysCache.fetchCount).toBe(0);
  });

  test("forged remote WS-auth signature → error then close 4001", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const alice = `alice@${fed.a.domain}`;

    const { client, nonce } = await connectAndChallenge(fed.b);
    nonces.set(client, nonce);
    // Claim alice's real key id but sign with a different private key.
    const wrong = generateKeyPair();
    sendAuthenticate(client, {
      actor: alice,
      keyId,
      privateKey: keypair.privateKey,
      authority: fed.b.domain,
      signWith: wrong.privateKey,
    });
    const err = await client.ofType("error");
    expect((err.data as { status: number }).status).toBe(401);
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
    client.close();
  });
});
