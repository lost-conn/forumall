/**
 * Cross-provider DM broadened-read test (spec §7.4, §8.3).
 *
 * A remote sender (alice on provider A) sends a DM to a local recipient (bob on
 * provider B) by POSTing to B's `/api/federation/dms/{dmId}/messages`, signed as
 * alice for B's authority. The message lands ONLY in bob's inbox on B (no sender
 * copy, §8.3). The broadened read then lets alice read her sent message back by
 * calling B's `GET /api/dms/{dmId}/messages` — even though she has no inbox of
 * her own on B (she is non-local there, scoped purely by `author`).
 *
 * Uses the {@link startFederation} harness: B resolves alice's key from A via the
 * user-keys cache when verifying her signed requests.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, deriveDmId, generateKeyPair, sign } from "@forumall/shared";

import { type Federation, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-dmsfed-"));
});

const open: Federation[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-dmsfed-"));
});

function boot(): Federation {
  const fed = startFederation(tmp);
  open.push(fed);
  return fed;
}

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

/** Register `handle` on provider A and add a device key. */
async function registerOnA(fed: Federation, handle: string): Promise<Signer> {
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
      device_name: "dev",
    }),
  });
  expect(dk.status).toBe(201);
  const { key_id } = (await dk.json()) as { key_id: string };
  return { keyId: key_id, privateKey: keypair.privateKey, actor: `${handle}@${fed.a.domain}` };
}

/** Register `handle` on provider B and add a device key. */
async function registerOnB(fed: Federation, handle: string): Promise<Signer> {
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
      device_name: "dev",
    }),
  });
  expect(dk.status).toBe(201);
  const { key_id } = (await dk.json()) as { key_id: string };
  return { keyId: key_id, privateKey: keypair.privateKey, actor: `${handle}@${fed.b.domain}` };
}

/** Send a user-signed request to provider B (signing for B's authority). */
async function signedReqToB(
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

describe("cross-provider DM broadened read (§7.4, §8.3)", () => {
  test("remote sender alice@A reads her sent DM back from recipient bob's provider B", async () => {
    const fed = boot();
    const alice = await registerOnA(fed, "alice");
    const bob = await registerOnB(fed, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice (remote) delivers a DM into bob's inbox on B (signed as alice for B).
    const sent = await signedReqToB(fed, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "x1",
      content: { mime: "text/plain", text: "hi bob from afar" },
    });
    expect(sent.status).toBe(201);
    const id = ((await sent.json()) as { id: string }).id;

    // alice reads B's history for the conversation → gets her sent row, even
    // though she has no inbox of her own on B (scoped by author, viewer.local=false).
    const aRead = await signedReqToB(fed, alice, "GET", `/api/dms/${dmId}/messages`);
    expect(aRead.status).toBe(200);
    const aItems = ((await aRead.json()) as { items: { id: string; author: string }[] }).items;
    expect(aItems.length).toBe(1);
    expect(aItems[0]?.id).toBe(id);
    expect(aItems[0]?.author).toBe(alice.actor);

    // bob (local recipient) also sees it in his own inbox.
    const bRead = await signedReqToB(fed, bob, "GET", `/api/dms/${dmId}/messages`);
    expect(bRead.status).toBe(200);
    const bItems = ((await bRead.json()) as { items: { id: string }[] }).items;
    expect(bItems.map((m) => m.id)).toEqual([id]);
  });
});
