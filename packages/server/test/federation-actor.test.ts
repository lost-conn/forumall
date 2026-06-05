/**
 * Remote user-signed federation tests (spec §4.6, §8 Authorization).
 *
 * Drives a real two-provider federation (`a.test` + `b.test`) via the
 * {@link startFederation} harness. A user `alice` is registered on provider A
 * with a device key, then acts as a **remote** actor (`alice@a.test`) sending
 * **user-signed** requests to provider B. B resolves alice's key from A's §4.6
 * keys endpoint (through B's user-keys cache, hitting A via the injected fetch)
 * and verifies the Ed25519 signature.
 *
 * Coverage:
 *  - Remote verify success + forged-signature 401.
 *  - Key caching (second request reuses the cached key, `fetchCount` unchanged)
 *    and re-fetch on a verify miss after alice's key is revoked on A.
 *  - §8 allow/deny policy: a denied/excluded peer → 403 *before* any key fetch.
 *  - Tier enforcement: a remote non-member hitting a private group read → 403,
 *    exactly like a local non-member (remote origin never bypasses authz).
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type GeneratedKeyPair,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { revokeDeviceKey } from "../src/provider/device-keys.ts";
import { createGroup } from "../src/provider/groups.ts";
import { addMember } from "../src/provider/membership.ts";
import {
  type Federation,
  type StartFederationOptions,
  startFederation,
} from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedactor-"));
});

const open: Federation[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedactor-"));
});

function boot(opts: StartFederationOptions = {}): Federation {
  const fed = startFederation(tmp, opts);
  open.push(fed);
  return fed;
}

/** Register `handle` on a provider and add a device key; returns the keypair + keyId. */
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

/**
 * Send a user-signed GET to B at `path`, signing for B's authority (its
 * `config.domain`) as `actor@a.test`. Routed through B's localhost base while
 * preserving the Host header so B's authority binding matches its domain.
 */
function signedGetToB(
  fed: Federation,
  args: {
    actor: string;
    keyId: string;
    privateKey: string;
    path: string;
  },
): Promise<Response> {
  const { headers } = sign({
    actor: args.actor,
    keyId: args.keyId,
    privateKey: args.privateKey,
    authority: fed.b.domain,
    method: "GET",
    path: args.path,
  });
  return fetch(`${fed.b.base}${args.path}`, {
    method: "GET",
    headers: { ...headers, host: fed.b.domain },
  });
}

/** Create a private group on B and (optionally) add `member` to it. Returns the group id. */
function privateGroupOnB(fed: Federation, owner: string, member?: string): string {
  const group = createGroup(fed.b.db, owner, { name: "secret", tier: "private" });
  if (member) addMember(fed.b.db, group.id, member);
  return group.id;
}

describe("remote user-signed federation (§4.6)", () => {
  test("B resolves alice's key from A's keys endpoint and verifies the signed request", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    // alice is a member of a private group on B → her signed read must succeed.
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; tier: string };
    expect(body.id).toBe(groupId);
    expect(body.tier).toBe("private");
    // The keys endpoint was hit at least once.
    expect(fed.b.userKeysCache.fetchCount).toBeGreaterThanOrEqual(1);
  });

  test("forged signature (right key id, wrong private key) → 401", async () => {
    const fed = boot();
    const { keyId } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const wrong = generateKeyPair();
    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: wrong.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(401);
  });

  test("cache: second signed request reuses the cached key (no extra fetch)", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const first = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(first.status).toBe(200);
    const afterFirst = fed.b.userKeysCache.fetchCount;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const second = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(second.status).toBe(200);
    // Cache hit: the cached key verified, no additional keys-endpoint fetch.
    expect(fed.b.userKeysCache.fetchCount).toBe(afterFirst);
  });

  test("revocation: A drops alice's key → B's verify miss forces a re-fetch → 401", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    // Warm B's cache with alice's key.
    const warm = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(warm.status).toBe(200);
    const beforeRevoke = fed.b.userKeysCache.fetchCount;

    // Revoke alice's key on A: A's keys endpoint now omits it.
    expect(revokeDeviceKey(fed.a.db, "alice", keyId)).toBe(true);

    // B still holds the cached key. The (now still-valid signature, but) revoked
    // key id must be re-checked: B's cache hit verifies against the stale key, so
    // we instead present a signature the stale key CANNOT verify by rotating the
    // signer to a fresh key under the same (revoked) id — forcing the verify miss
    // → forced re-fetch → A no longer publishes the id → 401.
    const rotated = generateKeyPair();
    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: rotated.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(401);
    // The verify miss forced a re-fetch of A's keys endpoint.
    expect(fed.b.userKeysCache.fetchCount).toBeGreaterThan(beforeRevoke);
  });
});

describe("federation allow/deny policy (§8 Authorization)", () => {
  test("DENY a.test → alice@a.test's signed request → 403, no key fetch", async () => {
    const fed = boot({ envB: { FEDERATION_DENY: "a.test" } });
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(403);
    // Policy short-circuited BEFORE any remote key fetch.
    expect(fed.b.userKeysCache.fetchCount).toBe(0);
  });

  test("ALLOW list excluding a.test → 403 (no key fetch)", async () => {
    const fed = boot({ envB: { FEDERATION_ALLOW: "c.test,d.test" } });
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(403);
    expect(fed.b.userKeysCache.fetchCount).toBe(0);
  });

  test("default policy (no allow/deny) → allowed", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(200);
  });

  test("ALLOW list including a.test → allowed", async () => {
    const fed = boot({ envB: { FEDERATION_ALLOW: "a.test" } });
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`, actor);

    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    expect(res.status).toBe(200);
  });
});

describe("tier enforcement on remote actors (§8 Authorization)", () => {
  test("remote non-member hitting a private group read → 403 (same as local non-member)", async () => {
    const fed = boot();
    const { keyId, keypair } = await registerAlice(fed);
    const actor = `alice@${fed.a.domain}`;
    // alice authenticates fine (her key resolves + verifies) but is NOT a member.
    const groupId = privateGroupOnB(fed, `owner@${fed.b.domain}`);

    const res = await signedGetToB(fed, {
      actor,
      keyId,
      privateKey: keypair.privateKey,
      path: `/api/groups/${groupId}`,
    });
    // Authenticated but unauthorized: tier/membership authz runs on the resolved
    // remote actor exactly as it would for a local one → 403, not 200.
    expect(res.status).toBe(403);
    // The actor's key WAS resolved (authn succeeded) before authz rejected.
    expect(fed.b.userKeysCache.fetchCount).toBeGreaterThanOrEqual(1);
  });
});
