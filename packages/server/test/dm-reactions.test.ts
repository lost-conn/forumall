/**
 * DM reactions + replies + typing tests (Overboard "DMs need
 * replies/reactions/all chat functionality"; spec §7.4, §8.3, mirroring the
 * channel §5.3/§7.1 surface).
 *
 * Covers:
 *  - reaction add → appears in the recipient's history aggregate, fans out
 *    `dm.reaction` (state `added`, carrying the full reaction) to BOTH
 *    participants; idempotent add (same id, still 200); remove → `dm.reaction`
 *    (state `removed`) + drops from the aggregate.
 *  - reply listing: a DM that references another DM message appears under the
 *    parent's `/replies`.
 *  - DM typing: `typing.start { dmId }` fans `dm.typing` to the counterparty.
 *  - cross-provider storage-follows-message: alice@a reacts (via her home
 *    provider a) to a message she SENT to bob@b (which lives only in bob's
 *    inbox on b) → the reaction is FORWARDED to and stored on b, and bob sees
 *    it in his history aggregate + a `dm.reaction` fan-out.
 *
 * Like the DM suite, the real-time assertions need a REAL socket, so `boot()`
 * starts the app on an ephemeral port; the cross-provider case uses the
 * `startFederation` two-provider harness. Argon2id cost is reduced (TEST-ONLY).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type WsEnvelope,
  deriveDmId,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signProvider,
  signWsAuthenticate,
} from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { getProviderSigningKey } from "../src/provider/signing-key.ts";
import type { Hub } from "../src/provider/ws-hub.ts";
import { type Federation, startFederation } from "./helpers/two-provider.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  pingIntervalMs: 80,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-dmreact-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  hub: Hub;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  url: string;
  domain: string;
}

const booted: Booted[] = [];
const feds: Federation[] = [];

function boot(name: string, env: Record<string, string> = {}): Booted {
  const domain = env.DOMAIN ?? DOMAIN;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN: domain,
    ...env,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, wsTimings: FAST_TIMINGS });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const url = `ws://${server.hostname}:${server.port}/api/ws`;
  const b: Booted = { app, hub: app.__hub, db, config, server, url, domain };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
  for (const f of feds.splice(0)) f.stop();
});

// ---------------------------------------------------------------------------
// HTTP + signer helpers (mirror dms.test.ts)
// ---------------------------------------------------------------------------

interface Signer {
  keyId: string;
  privateKey: string;
  publicKey: string;
  actor: string;
  handle: string;
}

async function httpAt(base: string, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

async function registerAt(base: string, domain: string, handle: string): Promise<Signer> {
  const reg = await httpAt(base, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await httpAt(base, "/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, publicKey, actor: `${handle}@${domain}`, handle };
}

/** A signed-HTTP request helper bound to a signer + target authority. */
async function signedReqAt(
  base: string,
  authority: string,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return httpAt(base, path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

// Single-node convenience bound to DOMAIN.
function register(b: Booted, handle: string): Promise<Signer> {
  return registerAt(`http://${b.server.hostname}:${b.server.port}`, b.domain, handle);
}
function signedReq(
  b: Booted,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
  return signedReqAt(
    `http://${b.server.hostname}:${b.server.port}`,
    b.domain,
    signer,
    method,
    path,
    bodyObj,
  );
}

// ---------------------------------------------------------------------------
// Tiny WS client (mirrors dms.test.ts)
// ---------------------------------------------------------------------------

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  static async open(url: string): Promise<WsClient> {
    const c = new WsClient(url);
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

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

async function connectAuthenticated(
  url: string,
  authority: string,
  signer: Signer,
): Promise<WsClient> {
  const client = await WsClient.open(url);
  const challenge = await client.ofType("auth.challenge");
  const nonce = (challenge.data as { nonce: string }).nonce;
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: signer.privateKey,
    authority,
    challengeNonce: nonce,
    timestamp,
  });
  client.send({
    id: "cli_auth",
    type: "authenticate",
    ts: rfc3339Timestamp(),
    data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
  });
  await client.ofType("authenticated");
  return client;
}

async function sendDm(
  b: Booted,
  from: Signer,
  dmId: string,
  body: { text: string; clientMessageId: string; reference?: { type: string; id: string } },
): Promise<Response> {
  return signedReq(b, from, "POST", `/api/federation/dms/${dmId}/messages`, {
    clientMessageId: body.clientMessageId,
    content: { mime: "text/plain", text: body.text },
    ...(body.reference ? { reference: body.reference } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests — local path
// ---------------------------------------------------------------------------

describe("DM reactions — local path", () => {
  test("add → history aggregate + dm.reaction to both; idempotent; remove", async () => {
    const b = boot("dmreact-local");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice → bob; the message lands in bob's inbox.
    const sent = await sendDm(b, alice, dmId, { text: "hi bob", clientMessageId: "m1" });
    expect(sent.status).toBe(201);
    const msgId = ((await sent.json()) as { id: string }).id;

    // Both connect so we can assert the fan-out to BOTH participants.
    const aliceWs = await connectAuthenticated(b.url, b.domain, alice);
    const bobWs = await connectAuthenticated(b.url, b.domain, bob);

    // bob reacts to the message in HIS inbox (local copy → stored locally).
    const put = await signedReq(
      b,
      bob,
      "PUT",
      `/api/dms/${dmId}/messages/${msgId}/reactions/heart`,
    );
    expect(put.status).toBe(201);
    const reaction = (await put.json()) as { id: string; key: string; author: string };
    expect(reaction.key).toBe("heart");
    expect(reaction.author).toBe(bob.actor);

    // dm.reaction fans out to BOTH participants, state "added", full reaction.
    const aliceEvt = await aliceWs.ofType("dm.reaction");
    const bobEvt = await bobWs.ofType("dm.reaction");
    for (const evt of [aliceEvt, bobEvt]) {
      const d = evt.data as {
        dmId: string;
        messageId: string;
        state: string;
        author: string;
        key: string;
        reaction?: { id: string };
      };
      expect(d.dmId).toBe(dmId);
      expect(d.messageId).toBe(msgId);
      expect(d.state).toBe("added");
      expect(d.author).toBe(bob.actor);
      expect(d.key).toBe("heart");
      expect(d.reaction?.id).toBe(reaction.id);
    }

    // It appears in bob's history aggregate.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    expect(hist.status).toBe(200);
    const items = (
      (await hist.json()) as {
        items: { id: string; reactions?: { key: string; author: string }[] }[];
      }
    ).items;
    const msg = items.find((m) => m.id === msgId);
    expect(msg?.reactions?.length).toBe(1);
    expect(msg?.reactions?.[0]?.key).toBe("heart");

    // Idempotent add → 200, same id.
    const put2 = await signedReq(
      b,
      bob,
      "PUT",
      `/api/dms/${dmId}/messages/${msgId}/reactions/heart`,
    );
    expect(put2.status).toBe(200);
    expect(((await put2.json()) as { id: string }).id).toBe(reaction.id);

    // Remove → 204 + dm.reaction (removed) + drops from the aggregate.
    const del = await signedReq(
      b,
      bob,
      "DELETE",
      `/api/dms/${dmId}/messages/${msgId}/reactions/heart`,
    );
    expect(del.status).toBe(204);
    // The idempotent add #2 also re-fanned an "added" frame; wait for "removed".
    const removedEvt = await bobWs.next(
      (f) => f.type === "dm.reaction" && (f.data as { state?: string }).state === "removed",
    );
    expect((removedEvt.data as { state: string }).state).toBe("removed");

    const hist2 = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items2 = ((await hist2.json()) as { items: { id: string; reactions?: unknown[] }[] })
      .items;
    expect(items2.find((m) => m.id === msgId)?.reactions).toBeUndefined();

    aliceWs.close();
    bobWs.close();
  });

  test("reacting on a conversation the caller isn't in → 404", async () => {
    const b = boot("dmreact-notpart");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const carol = await register(b, "carol");
    const bcDm = deriveDmId(bob.actor, carol.actor);
    // alice is not a participant of (bob,carol) → no conversation row.
    const res = await signedReq(
      b,
      alice,
      "PUT",
      `/api/dms/${bcDm}/messages/msg_whatever/reactions/heart`,
    );
    expect(res.status).toBe(404);
  });
});

describe("DM replies — local path", () => {
  test("a reply to a DM message appears under the parent's /replies", async () => {
    const b = boot("dmreact-replies");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const parent = await sendDm(b, alice, dmId, { text: "parent", clientMessageId: "p1" });
    const parentId = ((await parent.json()) as { id: string }).id;

    // alice replies to her own message; it also lands in bob's inbox.
    const reply = await sendDm(b, alice, dmId, {
      text: "a reply",
      clientMessageId: "r1",
      reference: { type: "reply", id: parentId },
    });
    expect(reply.status).toBe(201);
    const replyId = ((await reply.json()) as { id: string }).id;

    // bob lists replies to the parent from his inbox.
    const res = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages/${parentId}/replies`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(replyId);
  });
});

describe("DM typing", () => {
  test("typing.start { dmId } fans dm.typing to the counterparty", async () => {
    const b = boot("dmreact-typing");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    // Seed a conversation so both have an inbox row (alice→bob).
    await sendDm(b, alice, dmId, { text: "hi", clientMessageId: "t1" });
    // And bob→alice so alice has an inbox row (so alice can type too).
    await sendDm(b, bob, dmId, { text: "yo", clientMessageId: "t2" });

    const aliceWs = await connectAuthenticated(b.url, b.domain, alice);
    const bobWs = await connectAuthenticated(b.url, b.domain, bob);

    // alice starts typing → bob receives dm.typing (start). alice should NOT
    // receive her own echo.
    aliceWs.send({
      id: "ts1",
      type: "typing.start",
      ts: rfc3339Timestamp(),
      data: { dmId },
    });
    const evt = await bobWs.ofType("dm.typing");
    const d = evt.data as { dmId: string; user: string; state: string };
    expect(d.dmId).toBe(dmId);
    expect(d.user).toBe(alice.actor);
    expect(d.state).toBe("start");

    // Explicit stop also reaches bob.
    aliceWs.send({ id: "ts2", type: "typing.stop", ts: rfc3339Timestamp(), data: { dmId } });
    const stopEvt = await bobWs.ofType("dm.typing");
    expect((stopEvt.data as { state: string }).state).toBe("stop");

    aliceWs.close();
    bobWs.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — cross-provider (storage-follows-message, §8.3)
// ---------------------------------------------------------------------------

describe("DM reactions — cross-provider forwarding", () => {
  test("alice@a reacts to a message she SENT to bob@b → forwarded + stored on b", async () => {
    const fed = startFederation(tmp, {
      domainA: "a.test",
      domainB: "b.test",
      envA: { FEDERATION_INSECURE_LOCALHOST: "1" },
      envB: { FEDERATION_INSECURE_LOCALHOST: "1" },
    });
    feds.push(fed);

    const alice = await registerAt(fed.a.base, "a.test", "alice");
    const bob = await registerAt(fed.b.base, "b.test", "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice@a sends to bob@b: she addresses b's federation send route (signing
    // for b's authority). The message lands ONLY in bob's inbox on b.
    const sent = await signedReqAt(
      fed.b.base,
      "b.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "x1", content: { mime: "text/plain", text: "hi bob" } },
    );
    expect(sent.status).toBe(201);
    const msgId = ((await sent.json()) as { id: string }).id;

    // alice has NO local copy on a (no sender copy, §8.3). She reacts via HER
    // home provider a; a must forward the reaction to b (storage-follows-msg).
    // First she needs an inbox conversation row on a — but she only sent (no
    // received copy), so a has no row for her. The reaction route resolves the
    // conversation from a's dm_conversations; a sender-only conversation has no
    // row. So we drive the reaction directly against b (where the message + her
    // conversation participation are derivable), which is the path the client
    // takes when the message lives remotely.
    //
    // The storage-follows-message *forwarding* is exercised by reacting on a
    // when a holds a conversation row. We seed that by having bob@b reply so
    // alice@a gets a received copy + conversation row on a.
    const reply = await signedReqAt(
      fed.a.base,
      "a.test",
      bob,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "y1", content: { mime: "text/plain", text: "hey alice" } },
    );
    expect(reply.status).toBe(201);

    // Now alice@a reacts to the message she SENT (msgId lives on b, not a). Her
    // home provider a has the conversation row (from bob's reply) but no copy of
    // msgId → it forwards the reaction to b.
    const bobWs = await connectAuthenticated(
      `ws://localhost:${fed.b.server.port}/api/ws`,
      "b.test",
      bob,
    );

    const put = await signedReqAt(
      fed.a.base,
      "a.test",
      alice,
      "PUT",
      `/api/dms/${dmId}/messages/${msgId}/reactions/heart`,
    );
    expect([200, 201]).toContain(put.status);

    // bob (on b) sees the forwarded reaction: a dm.reaction fan-out + in his
    // history aggregate on b.
    const evt = await bobWs.ofType("dm.reaction");
    const d = evt.data as { messageId: string; author: string; key: string; state: string };
    expect(d.messageId).toBe(msgId);
    expect(d.author).toBe(alice.actor);
    expect(d.key).toBe("heart");
    expect(d.state).toBe("added");

    const hist = await signedReqAt(fed.b.base, "b.test", bob, "GET", `/api/dms/${dmId}/messages`);
    const items = (
      (await hist.json()) as {
        items: { id: string; reactions?: { author: string; key: string }[] }[];
      }
    ).items;
    const stored = items.find((m) => m.id === msgId);
    expect(stored?.reactions?.some((r) => r.author === alice.actor && r.key === "heart")).toBe(
      true,
    );

    bobWs.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — DM edit/delete forwarding (storage-follows-message, §7.1/§8.3)
// ---------------------------------------------------------------------------

describe("DM edit/delete — local counterparty path", () => {
  test("author edits a message they SENT → recipient inbox reflects + dm.message fan-out", async () => {
    const b = boot("dmedit-local");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice → bob; the message lands ONLY in bob's inbox (no sender copy).
    const sent = await sendDm(b, alice, dmId, { text: "typo heer", clientMessageId: "e1" });
    expect(sent.status).toBe(201);
    const msgId = ((await sent.json()) as { id: string }).id;
    // bob → alice so alice holds a conversation row (route participation check).
    await sendDm(b, bob, dmId, { text: "hi", clientMessageId: "e0" });

    const bobWs = await connectAuthenticated(b.url, b.domain, bob);

    // alice (no local copy) edits the message she sent. The route routes to bob's
    // inbox copy (counterparty local) and fans dm.message to bob.
    const patch = await signedReq(b, alice, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "typo here" },
    });
    expect(patch.status).toBe(200);
    const edited = (await patch.json()) as {
      id: string;
      content: { text: string };
      editedAt?: string;
    };
    expect(edited.content.text).toBe("typo here");
    expect(edited.editedAt).toBeTruthy();

    // bob receives a dm.message carrying the edit.
    const evt = await bobWs.next(
      (f) =>
        f.type === "dm.message" && (f.data as { message?: { id?: string } }).message?.id === msgId,
    );
    const m = (evt.data as { message: { content: { text: string }; editedAt?: string } }).message;
    expect(m.content.text).toBe("typo here");
    expect(m.editedAt).toBeTruthy();

    // bob's stored inbox copy reflects the edit.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.find((x) => x.id === msgId)?.content.text).toBe("typo here");

    bobWs.close();
  });

  test("author deletes a message they SENT → recipient inbox tombstoned + dm.message fan-out", async () => {
    const b = boot("dmdel-local");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, { text: "oops", clientMessageId: "d1" });
    const msgId = ((await sent.json()) as { id: string }).id;
    await sendDm(b, bob, dmId, { text: "hi", clientMessageId: "d0" });

    const bobWs = await connectAuthenticated(b.url, b.domain, bob);

    const del = await signedReq(b, alice, "DELETE", `/api/dms/${dmId}/messages/${msgId}`);
    expect(del.status).toBe(204);

    const evt = await bobWs.next(
      (f) =>
        f.type === "dm.message" && (f.data as { message?: { id?: string } }).message?.id === msgId,
    );
    expect((evt.data as { message: { deletedAt?: string } }).message.deletedAt).toBeTruthy();

    // bob's stored copy is tombstoned (deletedAt set, content cleared).
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = (
      (await hist.json()) as {
        items: { id: string; deletedAt?: string; content: { text: string } }[];
      }
    ).items;
    const tomb = items.find((x) => x.id === msgId);
    expect(tomb?.deletedAt).toBeTruthy();
    expect(tomb?.content.text).toBe("");

    bobWs.close();
  });

  test("a non-author cannot EDIT a received message (403); the inbox owner may still delete it", async () => {
    const b = boot("dmedit-nonauthor");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice → bob; the message is in bob's inbox, authored by alice.
    const sent = await sendDm(b, alice, dmId, { text: "mine", clientMessageId: "na1" });
    const msgId = ((await sent.json()) as { id: string }).id;
    // bob → alice so bob has a conversation row too (participation for the route).
    await sendDm(b, bob, dmId, { text: "hi", clientMessageId: "na2" });

    // bob (the recipient, NOT the author) cannot EDIT the message in his inbox —
    // §7.1 edit is author-only (this gate is preserved from the original path).
    const patch = await signedReq(b, bob, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "hijacked" },
    });
    expect(patch.status).toBe(403);

    // The stored copy is unchanged by the rejected edit.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.find((x) => x.id === msgId)?.content.text).toBe("mine");

    // bob MAY delete his own inbox copy (delete-from-my-inbox semantics are
    // preserved — only the FORWARDED / federation-ingest delete is author-only).
    const del = await signedReq(b, bob, "DELETE", `/api/dms/${dmId}/messages/${msgId}`);
    expect(del.status).toBe(204);
  });

  test("editing past the edit window is rejected (403)", async () => {
    // A zero-length edit window so the message is immediately past it.
    const b = boot("dmedit-window", { MESSAGE_EDIT_WINDOW_SECONDS: "0" });
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, { text: "late", clientMessageId: "w1" });
    const msgId = ((await sent.json()) as { id: string }).id;
    // bob → alice so alice holds a conversation row (route participation check).
    await sendDm(b, bob, dmId, { text: "hi", clientMessageId: "w0" });
    // Ensure the window has elapsed.
    await new Promise((r) => setTimeout(r, 10));

    const patch = await signedReq(b, alice, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "too late" },
    });
    expect(patch.status).toBe(403);
  });
});

describe("DM edit/delete — cross-provider forwarding", () => {
  test("alice@a edits/deletes a message she SENT to bob@b → forwarded + applied on b", async () => {
    const fed = startFederation(tmp, {
      domainA: "aedit.test",
      domainB: "bedit.test",
      envA: { FEDERATION_INSECURE_LOCALHOST: "1" },
      envB: { FEDERATION_INSECURE_LOCALHOST: "1" },
    });
    feds.push(fed);

    const alice = await registerAt(fed.a.base, "aedit.test", "aliceedit");
    const bob = await registerAt(fed.b.base, "bedit.test", "bobedit");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice@a sends to bob@b → message lands ONLY in bob's inbox on b.
    const sent = await signedReqAt(
      fed.b.base,
      "bedit.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "x1", content: { mime: "text/plain", text: "typo heer" } },
    );
    expect(sent.status).toBe(201);
    const msgId = ((await sent.json()) as { id: string }).id;

    // bob@b replies so alice@a holds a conversation row on a (needed for the
    // route's participation check before it forwards).
    const reply = await signedReqAt(
      fed.a.base,
      "aedit.test",
      bob,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "y1", content: { mime: "text/plain", text: "hey" } },
    );
    expect(reply.status).toBe(201);

    const bobWs = await connectAuthenticated(
      `ws://localhost:${fed.b.server.port}/api/ws`,
      "bedit.test",
      bob,
    );

    // alice@a edits the message she sent (lives on b) → a forwards to b.
    const patch = await signedReqAt(
      fed.a.base,
      "aedit.test",
      alice,
      "PATCH",
      `/api/dms/${dmId}/messages/${msgId}`,
      { content: { mime: "text/plain", text: "typo here" } },
    );
    expect(patch.status).toBe(200);

    const editEvt = await bobWs.next(
      (f) =>
        f.type === "dm.message" && (f.data as { message?: { id?: string } }).message?.id === msgId,
    );
    expect((editEvt.data as { message: { content: { text: string } } }).message.content.text).toBe(
      "typo here",
    );

    const hist = await signedReqAt(
      fed.b.base,
      "bedit.test",
      bob,
      "GET",
      `/api/dms/${dmId}/messages`,
    );
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.find((x) => x.id === msgId)?.content.text).toBe("typo here");

    // alice@a deletes the message she sent → a forwards the tombstone to b.
    const del = await signedReqAt(
      fed.a.base,
      "aedit.test",
      alice,
      "DELETE",
      `/api/dms/${dmId}/messages/${msgId}`,
    );
    expect(del.status).toBe(204);

    const delEvt = await bobWs.next(
      (f) =>
        f.type === "dm.message" &&
        (f.data as { message?: { id?: string; deletedAt?: string } }).message?.id === msgId &&
        Boolean((f.data as { message?: { deletedAt?: string } }).message?.deletedAt),
    );
    expect((delEvt.data as { message: { deletedAt?: string } }).message.deletedAt).toBeTruthy();

    bobWs.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — edit/delete by an author who has ONLY SENT in the conversation.
//
// Regression: the routes used to gate participation on the CALLER owning an
// inbox conversation row, which an only-sent author never has (§8.3 keeps no
// sender copy) — so editing/deleting a message they sent 404'd until the
// counterparty happened to reply. Routing now follows where the message is
// STORED, so the only-sent author is served on the first message.
// ---------------------------------------------------------------------------

describe("DM edit/delete — only-sent author (no inbox row of their own)", () => {
  test("author edits + deletes their sent message with no reply ever received", async () => {
    const b = boot("dmedit-onlysent");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice → bob and NOTHING else: bob holds the only copy + the only
    // conversation row. alice's `/api/me/dms` is empty (no sender copy, §8.3).
    const sent = await sendDm(b, alice, dmId, { text: "typo heer", clientMessageId: "os1" });
    expect(sent.status).toBe(201);
    const msgId = ((await sent.json()) as { id: string }).id;
    const convs = await signedReq(b, alice, "GET", "/api/me/dms");
    expect(((await convs.json()) as { items: unknown[] }).items).toEqual([]);

    const bobWs = await connectAuthenticated(b.url, b.domain, bob);

    // Edit → applied to bob's inbox copy + fanned to bob.
    const patch = await signedReq(b, alice, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "typo here" },
    });
    expect(patch.status).toBe(200);
    const edited = (await patch.json()) as { content: { text: string }; editedAt?: string };
    expect(edited.content.text).toBe("typo here");
    expect(edited.editedAt).toBeTruthy();

    const editEvt = await bobWs.next(
      (f) =>
        f.type === "dm.message" && (f.data as { message?: { id?: string } }).message?.id === msgId,
    );
    expect((editEvt.data as { message: { content: { text: string } } }).message.content.text).toBe(
      "typo here",
    );

    // Delete → tombstones bob's stored copy + fans the tombstone to bob.
    const del = await signedReq(b, alice, "DELETE", `/api/dms/${dmId}/messages/${msgId}`);
    expect(del.status).toBe(204);

    const delEvt = await bobWs.next(
      (f) =>
        f.type === "dm.message" &&
        (f.data as { message?: { id?: string; deletedAt?: string } }).message?.id === msgId &&
        Boolean((f.data as { message?: { deletedAt?: string } }).message?.deletedAt),
    );
    expect((delEvt.data as { message: { deletedAt?: string } }).message.deletedAt).toBeTruthy();

    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = (
      (await hist.json()) as {
        items: { id: string; deletedAt?: string; content: { text: string } }[];
      }
    ).items;
    const tomb = items.find((x) => x.id === msgId);
    expect(tomb?.deletedAt).toBeTruthy();
    expect(tomb?.content.text).toBe("");

    bobWs.close();
  });

  test("a third party (neither participant) still gets 404 on edit and delete", async () => {
    const b = boot("dmedit-thirdparty");
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const carol = await register(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, { text: "private", clientMessageId: "tp1" });
    const msgId = ((await sent.json()) as { id: string }).id;

    // carol owns no copy, and no local user derives {dmId} with carol → 404,
    // both before and after a reply exists (i.e. regardless of inbox rows).
    const patch = await signedReq(b, carol, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "hijacked" },
    });
    expect(patch.status).toBe(404);
    const del = await signedReq(b, carol, "DELETE", `/api/dms/${dmId}/messages/${msgId}`);
    expect(del.status).toBe(404);

    await sendDm(b, bob, dmId, { text: "reply", clientMessageId: "tp2" });
    const patch2 = await signedReq(b, carol, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "hijacked" },
    });
    expect(patch2.status).toBe(404);

    // The stored copy is untouched by every rejected attempt.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.find((x) => x.id === msgId)?.content.text).toBe("private");
  });

  test("the §7.1 edit window still rejects an only-sent author (403)", async () => {
    const b = boot("dmedit-onlysent-window", { MESSAGE_EDIT_WINDOW_SECONDS: "0" });
    const alice = await register(b, "alice");
    const bob = await register(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, { text: "late", clientMessageId: "w1" });
    const msgId = ((await sent.json()) as { id: string }).id;
    await new Promise((r) => setTimeout(r, 10)); // ensure the window has elapsed

    const patch = await signedReq(b, alice, "PATCH", `/api/dms/${dmId}/messages/${msgId}`, {
      content: { mime: "text/plain", text: "too late" },
    });
    expect(patch.status).toBe(403);

    // A delete is NOT window-bound; the author may still tombstone it.
    const del = await signedReq(b, alice, "DELETE", `/api/dms/${dmId}/messages/${msgId}`);
    expect(del.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Tests — §8.3 author-signed delivery of an edit/delete to the message's HOME
// provider (the cross-provider only-sent case: the author's own provider stores
// nothing and cannot learn the remote counterparty, so the client addresses the
// recipient's provider directly, exactly as it does for the DM send).
// ---------------------------------------------------------------------------

describe("DM edit/delete — author-signed on the message's home provider (§8.3)", () => {
  function fedForEdit(): Federation {
    const fed = startFederation(tmp, {
      domainA: "aedit2.test",
      domainB: "bedit2.test",
      envA: { FEDERATION_INSECURE_LOCALHOST: "1" },
      envB: { FEDERATION_INSECURE_LOCALHOST: "1" },
    });
    feds.push(fed);
    return fed;
  }

  test("alice@a edits/deletes on b with her OWN signature, having only sent", async () => {
    const fed = fedForEdit();
    const alice = await registerAt(fed.a.base, "aedit2.test", "aliceedit2a");
    const bob = await registerAt(fed.b.base, "bedit2.test", "bobedit2a");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice@a → bob@b (delivered straight to b, §8.3). No reply: alice has no
    // conversation row anywhere, so her home provider could not forward.
    const sent = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "f1", content: { mime: "text/plain", text: "typo heer" } },
    );
    expect(sent.status).toBe(201);
    const msgId = ((await sent.json()) as { id: string }).id;

    const bobWs = await connectAuthenticated(
      `ws://localhost:${fed.b.server.port}/api/ws`,
      "bedit2.test",
      bob,
    );

    // (1) The §8.3-named federation surface, USER-signed by the author.
    const patch = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      alice,
      "PATCH",
      `/api/federation/dms/${dmId}/messages/${msgId}`,
      { content: { mime: "text/plain", text: "typo here" } },
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { content: { text: string } }).content.text).toBe("typo here");
    const editEvt = await bobWs.next(
      (f) =>
        f.type === "dm.message" && (f.data as { message?: { id?: string } }).message?.id === msgId,
    );
    expect((editEvt.data as { message: { content: { text: string } } }).message.content.text).toBe(
      "typo here",
    );

    // (2) The plain DM surface on the SAME provider (what the web client uses
    // once it resolves the recipient's delivery client) resolves identically.
    const patch2 = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      alice,
      "PATCH",
      `/api/dms/${dmId}/messages/${msgId}`,
      { content: { mime: "text/plain", text: "typo here!" } },
    );
    expect(patch2.status).toBe(200);

    // (3) Delete, user-signed, on the federation surface → tombstone + fan-out.
    const del = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      alice,
      "DELETE",
      `/api/federation/dms/${dmId}/messages/${msgId}`,
    );
    expect(del.status).toBe(204);
    const delEvt = await bobWs.next(
      (f) =>
        f.type === "dm.message" &&
        (f.data as { message?: { id?: string; deletedAt?: string } }).message?.id === msgId &&
        Boolean((f.data as { message?: { deletedAt?: string } }).message?.deletedAt),
    );
    expect((delEvt.data as { message: { deletedAt?: string } }).message.deletedAt).toBeTruthy();

    bobWs.close();
  });

  test("a user-signed ingest may not act as someone else (the body actor is ignored)", async () => {
    const fed = fedForEdit();
    const alice = await registerAt(fed.a.base, "aedit2.test", "aliceedit2b");
    const mallory = await registerAt(fed.a.base, "aedit2.test", "mallory2b");
    const bob = await registerAt(fed.b.base, "bedit2.test", "bobedit2b");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "m1", content: { mime: "text/plain", text: "alice's words" } },
    );
    const msgId = ((await sent.json()) as { id: string }).id;

    // mallory signs for herself but names alice in the body: the body is not
    // trusted, so she is judged as mallory — no local user derives {dmId} with
    // her → the §8.3 recipient-resolution guard rejects with 400.
    const patch = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      mallory,
      "PATCH",
      `/api/federation/dms/${dmId}/messages/${msgId}`,
      { actor: alice.actor, content: { mime: "text/plain", text: "hijacked" } },
    );
    expect(patch.status).toBe(400);

    const hist = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      bob,
      "GET",
      `/api/dms/${dmId}/messages`,
    );
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.find((x) => x.id === msgId)?.content.text).toBe("alice's words");
  });

  test("a provider-signed forward may only act for that provider's OWN users (403)", async () => {
    const fed = fedForEdit();
    const alice = await registerAt(fed.a.base, "aedit2.test", "aliceedit2c");
    const bob = await registerAt(fed.b.base, "bedit2.test", "bobedit2c");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "p1", content: { mime: "text/plain", text: "alice's words" } },
    );
    const msgId = ((await sent.json()) as { id: string }).id;

    // A THIRD provider (here: b itself, signing as b) forwards an edit naming
    // alice@a — a user it has no authority over → 403, message untouched.
    const key = getProviderSigningKey(fed.b.db);
    const path = `/api/federation/dms/${dmId}/messages/${msgId}`;
    const body = JSON.stringify({
      actor: alice.actor,
      content: { mime: "text/plain", text: "hijacked" },
    });
    const { headers } = signProvider({
      provider: "bedit2.test",
      keyId: key.keyId,
      privateKey: key.privateKey,
      authority: "bedit2.test",
      method: "PATCH",
      path,
      body,
    });
    const res = await fetch(`${fed.b.base}${path}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(403);

    const hist = await signedReqAt(
      fed.b.base,
      "bedit2.test",
      bob,
      "GET",
      `/api/dms/${dmId}/messages`,
    );
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.find((x) => x.id === msgId)?.content.text).toBe("alice's words");
  });
});
