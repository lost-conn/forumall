/**
 * Provider-signed federation tests (spec §8, §8.1).
 *
 * Drives a real two-provider federation (`a.test` + `b.test`) booted on
 * ephemeral ports via the {@link startFederation} harness, with an injected
 * `federationFetch` mapping each logical domain to its localhost port (authority
 * preserved). Exercises the full §8.1 outbound + inbound path:
 *
 *  - `signedProviderFetch` from A → B: B resolves A's published key from A's
 *    discovery doc (through B's discovery cache hitting A via the injected
 *    fetch) and verifies the provider-signed request; a guarded route accepts it
 *    and rejects a tampered / forged one (401).
 *  - Discovery cache reuse: a second A → B request hits the cache (fetch count
 *    unchanged); after A rotates its signing key the verify-miss forces a
 *    re-fetch and the new key verifies (§8.1 rotation rule).
 *  - A provider-signed request claiming an unknown/un-resolvable provider → 401.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, signProvider } from "@forumall/shared";

import { providerKeys } from "../src/db/schema.ts";
import { requireProviderSignature } from "../src/http/signature.ts";
import { signedProviderFetch } from "../src/provider/federation/http.ts";
import { getProviderSigningKey } from "../src/provider/signing-key.ts";
import { type Federation, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-fed-"));
});

const open: Federation[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-fed-"));
});

/**
 * Start a federation and mount a provider-signed-guarded route on B at
 * `/api/federation/ping` (registered before any request is dispatched).
 */
function bootGuarded(): Federation {
  const fed = startFederation(tmp);
  open.push(fed);
  fed.b.app.post("/api/federation/ping", requireProviderSignature(), (c) => {
    const actor = c.var.actor;
    return c.json({ from: actor?.actor, domain: actor?.domain });
  });
  return fed;
}

describe("provider-signed federation (§8.1)", () => {
  test("A → B: B resolves A's key from discovery and verifies the signed request", async () => {
    const fed = bootGuarded();
    // Ensure A's signing key exists + is published before B fetches discovery.
    const aKey = getProviderSigningKey(fed.a.db);

    const res = await signedProviderFetch(
      fed.a.db,
      fed.a.config,
      {
        method: "POST",
        url: `https://${fed.b.domain}/api/federation/ping`,
        body: JSON.stringify({ hello: "b" }),
        headers: { "content-type": "application/json" },
      },
      fed.a.federationFetch,
    );
    void aKey;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: string; domain: string };
    expect(body.from).toBe(fed.a.domain);
    expect(body.domain).toBe(fed.a.domain);
  });

  test("tampered body → 400 (digest mismatch) at B", async () => {
    const fed = bootGuarded();
    // Sign over one body but the harness must send a different one. We bypass
    // signedProviderFetch's body coupling by signing with the original body and
    // re-issuing through the injected fetch with a tampered body.
    const signed = await signedProviderFetch(
      fed.a.db,
      fed.a.config,
      {
        method: "POST",
        url: `https://${fed.b.domain}/api/federation/ping`,
        body: JSON.stringify({ original: true }),
        headers: { "content-type": "application/json" },
      },
      fed.a.federationFetch,
    );
    // The above already delivered a *valid* request; assert it was accepted so
    // the next, tampered attempt is meaningfully different.
    expect(signed.status).toBe(200);

    // Now craft a tampered request: same signed headers, different body. Reuse
    // the harness mapping by fetching B directly with a hand-built request.
    const valid = await buildSignedHeaders(fed, { original: true });
    const res = await fetch(`${fed.b.base}/api/federation/ping`, {
      method: "POST",
      headers: { ...valid, host: fed.b.domain, "content-type": "application/json" },
      body: JSON.stringify({ tampered: true }),
    });
    expect(res.status).toBe(400);
  });

  test("forged provider key (valid structure, wrong key) → 401 at B", async () => {
    const fed = bootGuarded();
    // A's real published key id, but sign with a DIFFERENT private key.
    const aKey = getProviderSigningKey(fed.a.db);
    const wrong = generateKeyPair();
    // Replace A's stored private seed in-memory by signing manually.
    const headers = await buildSignedHeadersWithKey(fed, {
      keyId: aKey.keyId,
      privateKey: wrong.privateKey,
      provider: fed.a.domain,
    });
    const res = await fetch(`${fed.b.base}/api/federation/ping`, {
      method: "POST",
      headers: { ...headers, host: fed.b.domain, "content-type": "application/json" },
      body: JSON.stringify({ original: true }),
    });
    expect(res.status).toBe(401);
  });

  test("discovery cache: second request reuses the cached doc (no extra fetch)", async () => {
    const fed = bootGuarded();
    getProviderSigningKey(fed.a.db);

    const send = () =>
      signedProviderFetch(
        fed.a.db,
        fed.a.config,
        {
          method: "POST",
          url: `https://${fed.b.domain}/api/federation/ping`,
          body: JSON.stringify({ n: 1 }),
          headers: { "content-type": "application/json" },
        },
        fed.a.federationFetch,
      );

    const first = await send();
    expect(first.status).toBe(200);
    const afterFirst = fed.b.discoveryCache.fetchCount;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const second = await send();
    expect(second.status).toBe(200);
    // Cache hit: no additional discovery fetch was performed.
    expect(fed.b.discoveryCache.fetchCount).toBe(afterFirst);
  });

  test("key rotation: A rotates its key → B re-fetches discovery and the new key verifies", async () => {
    const fed = bootGuarded();
    getProviderSigningKey(fed.a.db); // mint + publish A's initial key

    // Warm B's cache with A's discovery doc.
    const first = await signedProviderFetch(
      fed.a.db,
      fed.a.config,
      {
        method: "POST",
        url: `https://${fed.b.domain}/api/federation/ping`,
        body: JSON.stringify({ n: 1 }),
        headers: { "content-type": "application/json" },
      },
      fed.a.federationFetch,
    );
    expect(first.status).toBe(200);
    const beforeRotate = fed.b.discoveryCache.fetchCount;

    // Rotate A's signing key: replace the stored row with a fresh keypair.
    const fresh = generateKeyPair();
    fed.a.db.drizzle.delete(providerKeys).run();
    fed.a.db.drizzle
      .insert(providerKeys)
      .values({
        keyId: "psk-rotated",
        publicKey: fresh.publicKey,
        privateKey: fresh.privateKey,
        algorithm: "Ed25519",
        createdAt: Date.now(),
      })
      .run();
    // Sanity: A now signs with the rotated key.
    expect(getProviderSigningKey(fed.a.db).keyId).toBe("psk-rotated");

    // B's cache still holds the OLD discovery (old key id). The new request's
    // key id is unknown there → verify miss → forced re-fetch → new key verifies.
    const second = await signedProviderFetch(
      fed.a.db,
      fed.a.config,
      {
        method: "POST",
        url: `https://${fed.b.domain}/api/federation/ping`,
        body: JSON.stringify({ n: 2 }),
        headers: { "content-type": "application/json" },
      },
      fed.a.federationFetch,
    );
    expect(second.status).toBe(200);
    // The re-fetch happened (fetch count grew past the warm value).
    expect(fed.b.discoveryCache.fetchCount).toBeGreaterThan(beforeRotate);
  });

  test("unknown / un-resolvable provider domain → 401", async () => {
    const fed = bootGuarded();
    // Sign a request that claims provider `c.test` (not mapped in the harness).
    // B cannot fetch c.test's discovery (the injected fetch rejects it) → 401.
    const aKey = getProviderSigningKey(fed.a.db);
    const headers = await buildSignedHeadersWithKey(fed, {
      keyId: aKey.keyId,
      privateKey: aKey.privateKey,
      provider: "c.test",
    });
    const res = await fetch(`${fed.b.base}/api/federation/ping`, {
      method: "POST",
      headers: { ...headers, host: fed.b.domain, "content-type": "application/json" },
      body: JSON.stringify({ original: true }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Header builders used by the tamper/forge/unknown tests, which need the signed
// headers *without* the body coupling that signedProviderFetch enforces.
// ---------------------------------------------------------------------------

async function buildSignedHeaders(fed: Federation, body: unknown): Promise<Record<string, string>> {
  const key = getProviderSigningKey(fed.a.db);
  return buildSignedHeadersWithKey(fed, {
    keyId: key.keyId,
    privateKey: key.privateKey,
    provider: fed.a.domain,
    body,
  });
}

function buildSignedHeadersWithKey(
  fed: Federation,
  args: { keyId: string; privateKey: string; provider: string; body?: unknown },
): Record<string, string> {
  const { headers } = signProvider({
    provider: args.provider,
    keyId: args.keyId,
    privateKey: args.privateKey,
    authority: fed.b.domain,
    method: "POST",
    path: "/api/federation/ping",
    body: JSON.stringify(args.body ?? { original: true }),
  });
  return headers;
}
