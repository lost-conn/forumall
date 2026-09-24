/**
 * Regression (§4.5.1 / §7.5 Federation): `presence.subscribe` (and the REST
 * mirror, `GET /api/users/{userRef}/presence`) for a REMOTE user MUST NOT be
 * answered with a LOCAL namesake's presence.
 *
 * Before the fix, `http/ws.ts` normalized every `presence.subscribe` subject by
 * stripping whatever domain the client sent and re-appending THIS provider's
 * own authority (`${handle}@${authority}`). A subscribe to `bob@a.test` sent to
 * provider B therefore silently became `bob@b.test` — B's own local `bob` — and
 * both the initial snapshot and every live `presence.update` leaked his real
 * presence to a viewer asking about a completely different person. This is the
 * exact class of bug §4.5.1 names: reducing a full `handle@domain` actor
 * identity to a bare handle and using it to key provider-local storage.
 *
 * §7.5 Federation is explicit about the correct behavior: "a provider answers
 * `presence.subscribe` for the users it **hosts**" and "There is no
 * provider-to-provider presence relay in v0.1" — a client wanting a remote
 * user's presence subscribes on THAT user's home provider directly (§8.5
 * direct-WS), not through a third provider. So a non-hosted subject gets the
 * same uniform `offline` a hidden/nonexistent LOCAL user gets, never a
 * substituted local namesake's real state.
 *
 * The scenario below sets up the strongest possible check: the viewer (carol)
 * and the local namesake (bob) SHARE A GROUP, so bob's default `sharedGroups`
 * presence visibility WOULD show carol his real (online) state if the ref were
 * (incorrectly) resolved as local. Subscribing to `bob@a.test` — a's own
 * (unrelated) namespace — must still come back uniform offline, with no live
 * updates ever reaching that subscription, while `bob@b.test` (his real,
 * fully-qualified local ref) keeps working exactly as before.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Presence,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
} from "@forumall/shared";

import { type Federation, type Provider, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-remote-presence-"));
});

const open: Federation[] = [];
const openSockets: WebSocket[] = [];
afterEach(() => {
  for (const s of openSockets.splice(0)) {
    if (s.readyState === WebSocket.OPEN) s.close();
  }
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-remote-presence-"));
});

interface Signer {
  readonly actor: string;
  readonly handle: string;
  readonly keyId: string;
  readonly privateKey: string;
}

/** Register `handle` on `p` and mint a device key for it. */
async function register(p: Provider, handle: string): Promise<Signer> {
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
  return { actor: `${handle}@${p.domain}`, handle, keyId: key_id, privateKey: keypair.privateKey };
}

/** Send a user-signed REST request to provider `p`. */
async function signedReq(
  p: Provider,
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
    authority: p.domain,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return fetch(`${p.base}${path}`, {
    method,
    headers: {
      ...headers,
      host: p.domain,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

/** Make `owner` a private group on `p` and add `member` to it via an open invite. */
async function makeGroup(p: Provider, owner: Signer, member: Signer): Promise<void> {
  const gRes = await signedReq(p, owner, "POST", "/api/groups", { name: "g", tier: "private" });
  expect(gRes.status).toBe(201);
  const groupId = ((await gRes.json()) as { id: string }).id;
  const inv = await signedReq(p, owner, "POST", `/api/groups/${groupId}/invites`, {});
  expect(inv.status).toBe(201);
  const token = ((await inv.json()) as { token: string }).token;
  const red = await signedReq(p, member, "POST", `/api/invites/${token}/redeem`, {});
  expect(red.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Tiny WS client (subset of presence.test.ts / remote-handle-impersonation.test.ts).
// ---------------------------------------------------------------------------

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    openSockets.push(this.ws);
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
      const waiter = (f: WsEnvelope) => {
        if (!pred(f)) {
          this.queue.push(f);
          this.waiters.unshift(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(f);
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error("timeout waiting for frame"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  ofType(type: string, timeoutMs = 2000): Promise<WsEnvelope> {
    return this.next((f) => f.type === type, timeoutMs);
  }

  async none(pred: (f: WsEnvelope) => boolean, ms: number): Promise<boolean> {
    try {
      await this.next(pred, ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

async function connectAuthenticated(p: Provider, signer: Signer): Promise<WsClient> {
  const client = await WsClient.open(`ws://localhost:${p.server.port}/api/ws`);
  const challenge = await client.ofType("auth.challenge");
  const nonce = (challenge.data as { nonce: string }).nonce;
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: signer.privateKey,
    authority: p.domain,
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

interface PresenceData {
  user: string;
  presence: Presence;
}

/** Subscribe `client` to `subjects`' presence and collect the initial snapshots, keyed by the ECHOED subject id. */
async function presenceSubscribe(
  client: WsClient,
  subjects: string[],
): Promise<Map<string, Presence>> {
  client.send({
    id: "psub",
    type: "presence.subscribe",
    ts: rfc3339Timestamp(),
    data: { users: subjects },
  });
  const ack = await client.ofType("presence.subscribed");
  const ackedUsers = (ack.data as { users: string[] }).users;
  const snapshots = new Map<string, Presence>();
  for (let i = 0; i < subjects.length; i++) {
    const upd = await client.ofType("presence.update");
    const d = upd.data as PresenceData;
    snapshots.set(d.user, d.presence);
  }
  // The ack MUST echo the exact per-subject actors the snapshots are keyed by.
  expect(new Set(ackedUsers)).toEqual(new Set(snapshots.keys()));
  return snapshots;
}

describe("presence.subscribe for a remote user never leaks a local namesake (§4.5.1, §7.5)", () => {
  test("bob online on B + carol subscribes to bob@a.test → uniform offline, not bob's real presence", async () => {
    const fed = startFederation(tmp);
    open.push(fed);

    const bob = await register(fed.b, "bob");
    const carol = await register(fed.b, "carol");
    // carol shares a group with bob → bob's default `sharedGroups` presence
    // visibility WOULD show her his real state if the ref were (incorrectly)
    // resolved as local. This makes the test fail loudly if the bug returns.
    await makeGroup(fed.b, bob, carol);

    const bobConn = await connectAuthenticated(fed.b, bob);
    const carolConn = await connectAuthenticated(fed.b, carol);

    // Subscribe to BOTH the cross-domain ref (a.test's "bob", who doesn't even
    // exist on A) and bob's real, fully-qualified local ref in one request, so
    // both snapshots come back from the exact same code path side by side.
    const foreignRef = `bob@${fed.a.domain}`;
    const localRef = bob.actor; // bob@b.test
    const snap = await presenceSubscribe(carolConn, [foreignRef, localRef]);

    const foreign = snap.get(foreignRef) as Presence;
    expect(foreign.availability).toBe("offline");
    expect(foreign.status).toBeUndefined();
    expect(foreign.lastSeen).toBeUndefined();

    // The LOCAL ref, by contrast, shows bob's real (online) state — proving the
    // uniform offline above is not just "presence subscribe is broken", but
    // specifically the remote-ref protection.
    const local = snap.get(localRef) as Presence;
    expect(local.availability).toBe("online");

    // Live updates: bob sets `dnd`. Carol's LOCAL subscription gets it; her
    // subscription to the FOREIGN ref never fires at all (§7.5: no
    // provider-to-provider relay — and definitely never bob's real update).
    bobConn.send({
      id: "pset",
      type: "presence.set",
      ts: rfc3339Timestamp(),
      data: {
        availability: "dnd",
        status: "should never reach the foreign-ref subscriber as bob@a.test",
      },
    });
    const dndUpdate = await carolConn.next(
      (f) => f.type === "presence.update" && (f.data as PresenceData).user === localRef,
    );
    expect((dndUpdate.data as PresenceData).presence.availability).toBe("dnd");

    const noForeignUpdate = await carolConn.none(
      (f) => f.type === "presence.update" && (f.data as PresenceData).user === foreignRef,
      300,
    );
    expect(noForeignUpdate).toBe(true);

    bobConn.close();
    carolConn.close();
  });

  test("a local ref (handle@ownDomain) still resolves to the real local user", async () => {
    const fed = startFederation(tmp);
    open.push(fed);

    const bob = await register(fed.b, "bob");
    const carol = await register(fed.b, "carol");
    await makeGroup(fed.b, bob, carol);

    const bobConn = await connectAuthenticated(fed.b, bob);
    const carolConn = await connectAuthenticated(fed.b, carol);

    // `UserRefSchema` (shared/schemas/common.ts) requires `handle@domain` or an
    // https URI — a bare handle with no `@` is not a valid `presence.subscribe`
    // ref at the wire level, so the local case to exercise is the fully
    // qualified own-domain form.
    const snap = await presenceSubscribe(carolConn, [bob.actor]);
    expect(snap.get(bob.actor)?.availability).toBe("online");

    bobConn.close();
    carolConn.close();
  });

  test("REST GET /api/users/{userRef}/presence mirrors the WS behaviour for the same foreign ref", async () => {
    const fed = startFederation(tmp);
    open.push(fed);

    const bob = await register(fed.b, "bob");
    const carol = await register(fed.b, "carol");
    await makeGroup(fed.b, bob, carol);

    const bobConn = await connectAuthenticated(fed.b, bob);
    // Give the connection-derived online flip a moment to land.
    await Bun.sleep(30);

    // The foreign ref must NEVER come back as bob's real (online) presence.
    const foreignRes = await signedReq(
      fed.b,
      carol,
      "GET",
      `/api/users/${encodeURIComponent(`bob@${fed.a.domain}`)}/presence`,
    );
    // Provider B has no local user matching that (handle, domain) pair, so this
    // resolves the same way as any other unknown ref — 404 — and in particular
    // is NOT a 200 carrying bob's real presence.
    expect(foreignRes.status).toBe(404);

    // The real, fully-qualified local ref still works and shows bob online —
    // proving REST didn't just start refusing every presence read.
    const localRes = await signedReq(
      fed.b,
      carol,
      "GET",
      `/api/users/${encodeURIComponent(bob.actor)}/presence`,
    );
    expect(localRes.status).toBe(200);
    expect(((await localRes.json()) as Presence).availability).toBe("online");

    bobConn.close();
  });
});
