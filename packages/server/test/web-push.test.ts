/**
 * Web Push crypto tests — the make-or-break gate.
 *
 *  - RFC 8291 §5 worked-example vector: inject the RFC's fixed ephemeral key +
 *    salt and assert `encryptPayload` reproduces the exact published ciphertext
 *    body. If THIS fails, the crypto is wrong and nothing else matters.
 *  - VAPID JWT: structural decode + ES256 signature verification with the public
 *    key (raw r||s, JOSE) + `aud`/`exp`/`sub` claims.
 *  - `buildPushRequest`: header shape (VAPID Authorization, aes128gcm, TTL, …).
 */
import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import {
  b64urlDecode,
  b64urlEncode,
  buildPushRequest,
  encryptPayload,
  generateVapidKeys,
  vapidAuthHeader,
  vapidJwt,
} from "../src/lib/web-push.ts";

// RFC 8291 §5 worked example (https://www.rfc-editor.org/rfc/rfc8291#section-5).
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  // User-agent (receiver / subscription) keys.
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  // Application server (sender) ephemeral keys — fixed for reproducibility.
  serverPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  // The full aes128gcm body (header || ciphertext), base64url.
  expectedBody:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 §5 aes128gcm vector", () => {
  test("encryptPayload reproduces the published ciphertext", async () => {
    const payload = new TextEncoder().encode(RFC.plaintext);
    const { body } = await encryptPayload(payload, RFC.uaPublic, RFC.authSecret, {
      ephemeralPrivateKey: b64urlDecode(RFC.serverPrivate),
      salt: b64urlDecode(RFC.salt),
    });
    expect(b64urlEncode(body)).toBe(RFC.expectedBody);
  });
});

describe("VAPID JWT (RFC 8292)", () => {
  test("ES256 round-trips: header/claims decode and signature verifies", () => {
    const keys = generateVapidKeys();
    const endpoint = "https://push.example.net/push/abc123?token=xyz";
    const subject = "https://forumall.test";
    const now = Math.floor(Date.now() / 1000);
    const jwt = vapidJwt(endpoint, keys.privateKey, subject, now);

    const [h, c, sig] = jwt.split(".");
    expect(h && c && sig).toBeTruthy();

    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h as string)));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c as string)));
    expect(claims.aud).toBe("https://push.example.net");
    expect(claims.sub).toBe(subject);
    expect(claims.exp).toBe(now + 12 * 60 * 60);

    // Verify the raw r||s ES256 signature against the VAPID public key.
    const rawSig = b64urlDecode(sig as string);
    expect(rawSig.length).toBe(64);
    const digest = sha256(new TextEncoder().encode(`${h}.${c}`));
    const pub = b64urlDecode(keys.publicKey);
    expect(p256.verify(rawSig, digest, pub, { prehash: false })).toBe(true);
  });
});

describe("buildPushRequest", () => {
  test("assembles url + VAPID/aes128gcm headers + encrypted body", async () => {
    const keys = generateVapidKeys();
    const subscription = {
      endpoint: "https://push.example.net/push/abc123",
      p256dh: RFC.uaPublic,
      auth: RFC.authSecret,
    };
    const payload = new TextEncoder().encode(JSON.stringify({ title: "Hi" }));
    const req = await buildPushRequest(subscription, payload, keys, "https://forumall.test");

    expect(req.url).toBe(subscription.endpoint);
    expect(req.headers.Authorization.startsWith("vapid t=")).toBe(true);
    expect(req.headers.Authorization).toContain(`k=${keys.publicKey}`);
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req.headers["Content-Type"]).toBe("application/octet-stream");
    expect(req.headers.TTL).toBe("2419200");
    expect(req.headers["Content-Length"]).toBe(String(req.body.length));
    // Body starts with the 16-byte salt header; longer than payload + tag.
    expect(req.body.length).toBeGreaterThan(payload.length + 16);
  });

  test("vapidAuthHeader shape", () => {
    const keys = generateVapidKeys();
    const hdr = vapidAuthHeader(
      "https://push.example.net/x",
      keys.publicKey,
      keys.privateKey,
      "https://forumall.test",
    );
    expect(hdr).toMatch(/^vapid t=[^,]+, k=.+$/);
  });
});
