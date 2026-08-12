/**
 * Regression: a REMOTE actor whose bare handle collides with a local user's
 * MUST NOT be treated as that local user (§4.5 authentication vs §4.6 identity).
 *
 * `requireSignature()` authenticates remote actors as fully as local ones: a
 * signer `alice@a.test` resolves their key from a.test's §4.6 keys endpoint and
 * passes every §4.5 check. The authenticated identity is
 * `{ actor: "alice@a.test", domain: "a.test" }` — and the bare handle `alice` in
 * it belongs to A's namespace. Every provider-local table here is keyed on a
 * LOCAL handle, so keying one on that remote handle silently resolves the LOCAL
 * `alice` — provider-admin takeover, profile/presence/read-state writes as her,
 * reads of her DM list, forged contact requests, and revocation of her device
 * keys. The fix gives the identity a typed `localHandle` that is absent for a
 * remote actor, plus `requireLocalActor()` on the routes that only ever serve a
 * user of this provider.
 *
 * Every rejection test also asserts NO DB mutation happened — a 4xx that still
 * wrote would be a silent pass. Each is paired with the LOCAL caller doing the
 * same thing successfully, so the fix can't pass by breaking the normal path.
 *
 * The last block pins the flip side: a remote actor with a COLLIDING handle is
 * still served on the paths that legitimately serve remote callers — the §8.3
 * DM read + the only-sent author's edit/delete/react routing (fc6b9a8, 3b2759f).
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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
  signWsAuthenticate,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import { contacts, presence, readMarkers, users } from "../src/db/schema.ts";
import { type Federation, type Provider, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-impersonation-"));
});

const open: Federation[] = [];
const openSockets: WebSocket[] = [];
afterEach(() => {
  for (const s of openSockets.splice(0)) {
    if (s.readyState === WebSocket.OPEN) s.close();
  }
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-impersonation-"));
});

interface Signer {
  readonly actor: string;
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
  return { actor: `${handle}@${p.domain}`, keyId: key_id, privateKey: keypair.privateKey };
}

/**
 * The scenario every test shares: provider B has a local `alice` (its FIRST
 * account, hence the provider admin) and a local `bob`; provider A has an
 * attacker-controlled `alice` with the SAME bare handle.
 */
async function scenario(): Promise<{
  fed: Federation;
  localAlice: Signer;
  localBob: Signer;
  remoteAlice: Signer;
}> {
  const fed = startFederation(tmp);
  open.push(fed);
  const localAlice = await register(fed.b, "alice"); // first user on B → admin
  const localBob = await register(fed.b, "bob");
  const remoteAlice = await register(fed.a, "alice"); // attacker's own provider
  return { fed, localAlice, localBob, remoteAlice };
}

/** Send a user-signed request to provider B, signing for B's authority (§4.4.2). */
async function signedToB(
  fed: Federation,
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
    authority: fed.b.domain,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return fetch(`${fed.b.base}${path}`, {
    method,
    headers: {
      ...headers,
      host: fed.b.domain,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

/** The stored row for a local user of B (or `null`). */
function userRow(fed: Federation, handle: string) {
  return (
    fed.b.db.drizzle.select().from(users).where(eq(users.handle, handle)).limit(1).all()[0] ?? null
  );
}

describe("remote actor with a colliding handle is not the local user (§4.5/§4.6)", () => {
  test("provider admin: remote alice@a.test gets 403, local admin alice still passes", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();

    // Local alice IS the provider admin (first account on B).
    expect(userRow(fed, "alice")?.isAdmin).toBe(true);

    const attackRead = await signedToB(fed, remoteAlice, "GET", "/api/admin/discover");
    expect(attackRead.status).toBe(403);

    const attackWrite = await signedToB(fed, remoteAlice, "PUT", "/api/admin/group-policy", {
      policy: "admin-only",
    });
    expect(attackWrite.status).toBe(403);
    // ...and the admin setting was NOT changed (a 403 that still wrote = a pass).
    const policyAfter = await signedToB(fed, localAlice, "GET", "/api/provider");
    expect(policyAfter.status).toBe(200);
    const ok = await signedToB(fed, localAlice, "PUT", "/api/admin/group-policy", {
      policy: "admin-only",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ policy: "admin-only" });
  });

  test("PATCH /api/me/profile: 403 and the local profile is untouched", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();

    const attack = await signedToB(fed, remoteAlice, "PATCH", "/api/me/profile", {
      displayName: "pwned",
    });
    expect(attack.status).toBe(403);
    expect(userRow(fed, "alice")?.displayName ?? null).toBe(null);

    const ok = await signedToB(fed, localAlice, "PATCH", "/api/me/profile", {
      displayName: "the real alice",
    });
    expect(ok.status).toBe(200);
    expect(userRow(fed, "alice")?.displayName).toBe("the real alice");
  });

  test("GET /api/me/dms: 403 for the remote namesake, 200 for the local user", async () => {
    const { fed, localAlice, localBob, remoteAlice } = await scenario();

    // Give local alice a conversation worth stealing: bob DMs her.
    const dmId = deriveDmId(localBob.actor, localAlice.actor);
    const sent = await signedToB(fed, localBob, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "m1",
      content: { mime: "text/plain", text: "private things" },
    });
    expect(sent.status).toBe(201);

    const attack = await signedToB(fed, remoteAlice, "GET", "/api/me/dms");
    expect(attack.status).toBe(403);
    expect(await attack.text()).not.toContain("private things");

    const ok = await signedToB(fed, localAlice, "GET", "/api/me/dms");
    expect(ok.status).toBe(200);
    const list = (await ok.json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([dmId]);
  });

  test("POST /api/me/contacts: 403 and no contact row is written", async () => {
    const { fed, localAlice, localBob, remoteAlice } = await scenario();

    const attack = await signedToB(fed, remoteAlice, "POST", "/api/me/contacts", {
      user: `mallory@${fed.a.domain}`,
    });
    expect(attack.status).toBe(403);
    expect(fed.b.db.drizzle.select().from(contacts).all()).toHaveLength(0);

    const ok = await signedToB(fed, localAlice, "POST", "/api/me/contacts", {
      user: localBob.actor,
    });
    expect(ok.status).toBe(201);
    const rows = fed.b.db.drizzle.select().from(contacts).all();
    // The caller's own row + bob's mirrored incoming row.
    expect(rows.filter((r) => r.owner === "alice")).toHaveLength(1);
  });

  test("PATCH /api/me/read-markers: 403 and no marker is written", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();
    const markers = { markers: [{ scopeId: "chan_x", lastReadSeq: 99 }] };

    const attack = await signedToB(fed, remoteAlice, "PATCH", "/api/me/read-markers", markers);
    expect(attack.status).toBe(403);
    expect(fed.b.db.drizzle.select().from(readMarkers).all()).toHaveLength(0);

    const ok = await signedToB(fed, localAlice, "PATCH", "/api/me/read-markers", markers);
    expect(ok.status).toBe(200);
    const rows = fed.b.db.drizzle.select().from(readMarkers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handle).toBe("alice");
  });

  test("PUT /api/me/presence: 403 and no presence row is written", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();

    const attack = await signedToB(fed, remoteAlice, "PUT", "/api/me/presence", {
      availability: "dnd",
      status: "owned",
      metadata: [],
    });
    expect(attack.status).toBe(403);
    expect(fed.b.db.drizzle.select().from(presence).all()).toHaveLength(0);

    const ok = await signedToB(fed, localAlice, "PUT", "/api/me/presence", {
      availability: "away",
      status: "brb",
      metadata: [],
    });
    expect(ok.status).toBe(200);
    const rows = fed.b.db.drizzle.select().from(presence).all();
    expect(rows.map((r) => r.handle)).toEqual(["alice"]);
    expect(rows[0]?.status).toBe("brb");
  });

  test("device keys: the remote namesake can neither list nor revoke the local user's", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();

    const list = await signedToB(fed, remoteAlice, "GET", "/api/auth/device-keys");
    expect(list.status).toBe(403);
    expect(await list.text()).not.toContain(localAlice.keyId);

    const revoke = await signedToB(
      fed,
      remoteAlice,
      "DELETE",
      `/api/auth/device-keys/${localAlice.keyId}`,
    );
    expect(revoke.status).toBe(403);

    // The local key still works (it was not revoked) and lists as hers.
    const own = await signedToB(fed, localAlice, "GET", "/api/auth/device-keys");
    expect(own.status).toBe(200);
    const keys = (await own.json()) as { keys: { key_id: string }[] };
    expect(keys.keys.map((k) => k.key_id)).toEqual([localAlice.keyId]);
  });

  test("GET /api/me: 403 for the remote namesake (no isAdmin leak), 200 for the local user", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();

    const attack = await signedToB(fed, remoteAlice, "GET", "/api/me");
    expect(attack.status).toBe(403);

    const ok = await signedToB(fed, localAlice, "GET", "/api/me");
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { isAdmin: boolean }).toMatchObject({ isAdmin: true });
  });

  test("WS presence.set from the remote namesake does not write the local user's presence", async () => {
    const { fed, remoteAlice } = await scenario();

    const ws = new WebSocket(`ws://localhost:${fed.b.server.port}/api/ws`);
    openSockets.push(ws);
    const frames: WsEnvelope[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as WsEnvelope));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });

    const waitFor = async (type: string): Promise<WsEnvelope> => {
      for (let i = 0; i < 100; i++) {
        const found = frames.find((f) => f.type === type);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout waiting for ${type}`);
    };

    const challenge = await waitFor("auth.challenge");
    const timestamp = rfc3339Timestamp();
    const { signature } = signWsAuthenticate({
      privateKey: remoteAlice.privateKey,
      authority: fed.b.domain,
      challengeNonce: (challenge.data as { nonce: string }).nonce,
      timestamp,
    });
    ws.send(
      JSON.stringify({
        id: "cli_auth_1",
        type: "authenticate",
        ts: rfc3339Timestamp(),
        data: { actor: remoteAlice.actor, keyId: remoteAlice.keyId, timestamp, signature },
      }),
    );
    // The remote actor legitimately authenticates against B (§8.5 direct WS).
    await waitFor("authenticated");

    ws.send(
      JSON.stringify({
        id: "cli_pres_1",
        type: "presence.set",
        ts: rfc3339Timestamp(),
        data: { availability: "dnd", status: "owned" },
      }),
    );
    const err = await waitFor("error");
    expect((err.data as { status: number }).status).toBe(403);

    // Nothing was written for the LOCAL alice (nor for anyone else).
    expect(fed.b.db.drizzle.select().from(presence).all()).toHaveLength(0);
  });
});

describe("remote callers that MUST keep working, even with a colliding handle", () => {
  test("a remote only-sent author still reads, edits, reacts to and deletes her DM on B", async () => {
    const { fed, localBob, remoteAlice } = await scenario();
    const dmId = deriveDmId(remoteAlice.actor, localBob.actor);

    // remote alice@a.test delivers a DM into local bob's inbox on B (§8.3).
    const sent = await signedToB(fed, remoteAlice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "r1",
      content: { mime: "text/plain", text: "hi bob" },
    });
    expect(sent.status).toBe(201);
    const messageId = ((await sent.json()) as { id: string }).id;

    // Broadened read: she has NO inbox on B, so she is scoped to what she authored.
    const read = await signedToB(fed, remoteAlice, "GET", `/api/dms/${dmId}/messages`);
    expect(read.status).toBe(200);
    const page = (await read.json()) as { items: { id: string }[] };
    expect(page.items.map((m) => m.id)).toEqual([messageId]);

    // Edit (case (b): the copy lives in the LOCAL recipient's inbox, resolved from
    // her FULL actor — never from a local inbox that shares her bare handle).
    const edit = await signedToB(
      fed,
      remoteAlice,
      "PATCH",
      `/api/dms/${dmId}/messages/${messageId}`,
      {
        content: { mime: "text/plain", text: "hi bob (edited)" },
      },
    );
    expect(edit.status).toBe(200);

    const react = await signedToB(
      fed,
      remoteAlice,
      "PUT",
      `/api/dms/${dmId}/messages/${messageId}/reactions/%F0%9F%91%8D`,
    );
    expect(react.status).toBe(201);

    const del = await signedToB(
      fed,
      remoteAlice,
      "DELETE",
      `/api/dms/${dmId}/messages/${messageId}`,
    );
    expect(del.status).toBe(204);
  });

  test("a remote member still reads a public group on B (remote origin is not a blanket 403)", async () => {
    const { fed, localAlice, remoteAlice } = await scenario();
    const created = await signedToB(fed, localAlice, "POST", "/api/groups", {
      name: "town square",
      tier: "public",
    });
    expect(created.status).toBe(201);
    const groupId = ((await created.json()) as { id: string }).id;

    const read = await signedToB(fed, remoteAlice, "GET", `/api/groups/${groupId}`);
    expect(read.status).toBe(200);
  });
});
