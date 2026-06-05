/**
 * Signing HTTP client unit tests (§4.4 / §4.5).
 *
 * Proves the `X-OFSCP-*` headers the client attaches are exactly what the
 * server's §4.5 middleware accepts: we build a signed request with a test
 * keypair and verify the produced headers + reconstructed canonical string with
 * the shared `verify()` (round-trip), and that `X-OFSCP-Content-Digest` matches
 * a known body digest.
 */
import { describe, expect, test } from "bun:test";
import {
  HEADER,
  contentDigest,
  generateKeyPair,
  publicKeyFromPrivate,
  verify,
} from "@forumall/shared";

import { OfscpClient } from "../src/lib/ofscp-client.ts";

const HOST = "providera.com";
const BASE = `https://${HOST}`;

function makeClient(privateKey: string): OfscpClient {
  return new OfscpClient({
    baseUrl: BASE,
    actor: "alice@providera.com",
    keyId: "key_test_1",
    privateKey,
  });
}

describe("OfscpClient signed request (§4.4/§4.5 round-trip)", () => {
  test("POST headers verify with shared verify() and digest matches the body", () => {
    const { privateKey } = generateKeyPair();
    const publicKey = publicKeyFromPrivate(privateKey);
    const client = makeClient(privateKey);

    const body = { name: "g", tier: "public" };
    const bodyText = JSON.stringify(body);
    const { url, headers } = client.buildRequest("POST", "/api/groups", body);

    // Identity headers present + correct.
    expect(headers[HEADER.ACTOR]).toBe("alice@providera.com");
    expect(headers[HEADER.KEY_ID]).toBe("key_test_1");
    expect(headers["content-type"]).toBe("application/json");

    // Content digest matches the EXACT serialized body the client will send.
    expect(headers[HEADER.CONTENT_DIGEST]).toBe(contentDigest(bodyText));

    // The signature verifies against the reconstructed canonical string —
    // exactly the server's §4.5 step 7 check.
    const ok = verify({
      publicKey,
      authority: url.host,
      method: "POST",
      path: url.pathname,
      query: url.search,
      timestamp: headers[HEADER.TIMESTAMP] as string,
      nonce: headers[HEADER.NONCE] as string,
      contentDigest: headers[HEADER.CONTENT_DIGEST] as string,
      signature: headers[HEADER.SIGNATURE] as string,
    });
    expect(ok).toBe(true);
  });

  test("GET with a query string signs over the raw query + empty-body digest", () => {
    const { privateKey } = generateKeyPair();
    const publicKey = publicKeyFromPrivate(privateKey);
    const client = makeClient(privateKey);

    const { url, headers } = client.buildRequest(
      "GET",
      "/api/groups/grp_1/channels/chn_1/messages?limit=20&before=cur_x",
    );

    // Empty body → the canonical empty-body digest.
    expect(headers[HEADER.CONTENT_DIGEST]).toBe(contentDigest(""));

    const ok = verify({
      publicKey,
      authority: url.host,
      method: "GET",
      path: url.pathname,
      query: url.search,
      timestamp: headers[HEADER.TIMESTAMP] as string,
      nonce: headers[HEADER.NONCE] as string,
      contentDigest: headers[HEADER.CONTENT_DIGEST] as string,
      signature: headers[HEADER.SIGNATURE] as string,
    });
    expect(ok).toBe(true);

    // A tampered query must NOT verify (binds the query into the signature).
    const bad = verify({
      publicKey,
      authority: url.host,
      method: "GET",
      path: url.pathname,
      query: "?limit=21&before=cur_x",
      timestamp: headers[HEADER.TIMESTAMP] as string,
      nonce: headers[HEADER.NONCE] as string,
      contentDigest: headers[HEADER.CONTENT_DIGEST] as string,
      signature: headers[HEADER.SIGNATURE] as string,
    });
    expect(bad).toBe(false);
  });

  test("a non-default port is carried into the signing authority", () => {
    const { privateKey } = generateKeyPair();
    const publicKey = publicKeyFromPrivate(privateKey);
    const client = new OfscpClient({
      baseUrl: "https://providera.com:8443",
      actor: "alice@providera.com",
      keyId: "key_test_1",
      privateKey,
    });
    const { url, headers } = client.buildRequest("GET", "/api/me");
    expect(url.host).toBe("providera.com:8443");
    const ok = verify({
      publicKey,
      authority: url.host,
      method: "GET",
      path: "/api/me",
      query: "",
      timestamp: headers[HEADER.TIMESTAMP] as string,
      nonce: headers[HEADER.NONCE] as string,
      contentDigest: headers[HEADER.CONTENT_DIGEST] as string,
      signature: headers[HEADER.SIGNATURE] as string,
    });
    expect(ok).toBe(true);
  });

  test("anonymous client / forced-anonymous request attaches no signing headers", () => {
    const anon = new OfscpClient({ baseUrl: BASE });
    const { headers } = anon.buildRequest("POST", "/api/auth/login", {
      handle: "a",
      password: "b",
    });
    expect(headers[HEADER.SIGNATURE]).toBeUndefined();
    expect(headers[HEADER.ACTOR]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");

    const { privateKey } = generateKeyPair();
    const signed = makeClient(privateKey);
    const forced = signed.buildRequest("GET", "/.well-known/ofscp-provider", undefined, {
      anonymous: true,
    });
    expect(forced.headers[HEADER.SIGNATURE]).toBeUndefined();
  });

  test("bearer (bootstrap) request attaches Authorization, not signing headers", () => {
    const { privateKey } = generateKeyPair();
    const client = makeClient(privateKey);
    const { headers } = client.buildRequest(
      "POST",
      "/api/auth/device-keys",
      { public_key: "x", algorithm: "Ed25519", device_name: "dev" },
      { bearer: "boot_token_123" },
    );
    expect(headers.authorization).toBe("Bearer boot_token_123");
    expect(headers[HEADER.SIGNATURE]).toBeUndefined();
  });
});
