/**
 * WebSocket handshake tests (spec §7.1 Authentication): the signed
 * challenge, failures and their close codes, timeouts and the shared replay store.
 *
 * See `helpers/ws-harness.ts` for the real-socket harness.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPair, rfc3339Timestamp } from "@forumall/shared";

import {
  DOMAIN,
  FAST_TIMINGS,
  WsClient,
  connectAndChallenge,
  registerUserWithKey,
  sendAuthenticate,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-handshake-");

describe("WS handshake (§7.1 Authentication)", () => {
  test("first server frame is auth.challenge with a nonce", async () => {
    const b = boot("challenge-first");
    const client = await WsClient.open(b.url);
    const first = await client.next();
    expect(first.type).toBe("auth.challenge");
    const data = first.data as { nonce: string; expiresAt: string };
    expect(typeof data.nonce).toBe("string");
    expect(data.nonce.length).toBeGreaterThan(0);
    expect(typeof data.expiresAt).toBe("string");
    client.close();
  });

  test("a command other than authenticate first → closed 4001", async () => {
    const b = boot("wrong-first");
    const { client } = await connectAndChallenge(b);
    client.send({ id: "cli_1", type: "subscribe", data: { channels: ["chn_x"] } });
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  test("valid authenticate → authenticated { actor }", async () => {
    const b = boot("auth-ok");
    const signer = await registerUserWithKey(b, "alice");
    const { client, nonce } = await connectAndChallenge(b);
    sendAuthenticate(client, signer, nonce, { id: "cli_auth_X" });
    const ack = await client.ofType("authenticated");
    expect((ack.data as { actor: string }).actor).toBe(signer.actor);
    expect(ack.correlationId).toBe("cli_auth_X");
    client.close();
  });

  test("bad signature → error then close 4001", async () => {
    const b = boot("auth-badsig");
    const signer = await registerUserWithKey(b, "alice");
    const { client, nonce } = await connectAndChallenge(b);
    // Sign with a different private key but claim the registered key id.
    const wrong = generateKeyPair();
    sendAuthenticate(client, signer, nonce, { signWith: wrong.privateKey });
    const err = await client.ofType("error");
    expect((err.data as { status: number }).status).toBe(401);
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  // §2.2: the `authenticate` actor MUST be canonical; Forumall rejects (rather
  // than converts) a non-canonical spelling of an otherwise valid identity.
  for (const [i, spelling] of [
    `alice@${DOMAIN}:443`,
    `alice@${DOMAIN.toUpperCase()}`,
    `alice@${DOMAIN}.`,
    `Alice@${DOMAIN}`,
    // Aliases a URL parser resolves to the real host (review of #23).
    `alice@${DOMAIN}:0443`,
    `alice@${DOMAIN}:00443`,
    `alice@x@${DOMAIN}`,
    `alice@${DOMAIN}/x?`,
    "alice@0x01020304",
    "alice@[0:0:0:0:0:0:0:1]",
    "alice@a..test",
    "alice@.a.test",
    `alice@${DOMAIN}:abc`,
    `alice@${DOMAIN}:65536`,
    "alice@999.1.1.1",
    "alice@4294967296",
  ].entries()) {
    test(`non-canonical actor ${spelling} → error then close 4001`, async () => {
      const b = boot(`auth-noncanon-${i}`);
      const signer = await registerUserWithKey(b, "alice");
      const { client, nonce } = await connectAndChallenge(b);
      // Correctly signed with alice's real key — only the actor spelling differs.
      sendAuthenticate(client, { ...signer, actor: spelling }, nonce);
      const err = await client.ofType("error");
      expect((err.data as { status: number }).status).toBe(401);
      await client.waitClosed();
      expect(client.closeCode).toBe(4001);
    });
  }

  test("authenticate with a different/old nonce (not the one issued) → rejected", async () => {
    const b = boot("auth-wrongnonce");
    const signer = await registerUserWithKey(b, "alice");
    const { client } = await connectAndChallenge(b);
    // Sign over a nonce the server never issued for this connection.
    sendAuthenticate(client, signer, "some-other-nonce-AAAAAAAAAAAAAAAA");
    const err = await client.ofType("error");
    expect((err.data as { status: number }).status).toBe(401);
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  test("no authenticate within the timeout → closed", async () => {
    const b = boot("auth-timeout", { ...FAST_TIMINGS, authTimeoutMs: 120 });
    const { client } = await connectAndChallenge(b);
    // Send nothing; the auth-timeout must close us, with 4001 (§7.1).
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  // #21: the WS handshake now checks/burns the (key_id, challenge nonce) pair
  // against the SAME provider-wide replay store the REST signature middleware
  // uses (`c.var.nonceStore`), in addition to the existing per-connection
  // `challengeUsed` one-shot flag. A real ≥128-bit random challenge nonce never
  // collides across connections in practice, so this forces the collision with
  // an injected deterministic nonce generator (`mintChallengeNonce` override,
  // test-only) to exercise the shared-store guard specifically — as opposed to
  // the per-connection check, which a SECOND, distinct connection object does
  // not share.
  test("a challenge nonce reused on a different connection is rejected (shared store, not just per-connection)", async () => {
    const FIXED_NONCE = "fixed-ws-challenge-nonce-AAAAAAAA";
    const b = boot("ws-nonce-shared", FAST_TIMINGS, {}, () => FIXED_NONCE);
    const signer = await registerUserWithKey(b, "alice");

    // Connection 1: authenticate over the (fixed) challenge nonce → succeeds
    // and burns (keyId, FIXED_NONCE) into the shared store.
    const conn1 = await connectAndChallenge(b);
    expect(conn1.nonce).toBe(FIXED_NONCE);
    sendAuthenticate(conn1.client, signer, conn1.nonce);
    await conn1.client.ofType("authenticated");

    // Connection 2: a BRAND NEW connection (its own `challengeUsed = false`),
    // issued the SAME challenge nonce by the (mocked) generator. Authenticating
    // with it must be rejected by the shared store even though this specific
    // connection never used it before.
    const conn2 = await connectAndChallenge(b);
    expect(conn2.nonce).toBe(FIXED_NONCE);
    sendAuthenticate(conn2.client, signer, conn2.nonce, { id: "cli_auth_reuse" });
    const err = await conn2.client.ofType("error");
    expect((err.data as { status: number; message: string }).status).toBe(401);
    expect((err.data as { message: string }).message).toContain("already used");
    await conn2.client.waitClosed();
    expect(conn2.client.closeCode).toBe(4001);

    conn1.client.close();
  });
});

describe("WS handshake failures and close codes (§7.1)", () => {
  for (const [label, payload] of [
    ["a frame that is not JSON", "{not json"],
    ["a frame with no type", JSON.stringify({ id: "cli_x", data: {} })],
    ["an unknown command type", JSON.stringify({ id: "cli_x", type: "x.future", data: {} })],
  ] as const) {
    test(`${label} before authenticate → closed 4001 with no error`, async () => {
      const b = boot("pre-auth-frame");
      const { client } = await connectAndChallenge(b);
      client.sendText(payload);
      await client.waitClosed();
      expect(client.closeCode).toBe(4001);
      expect(await client.none((f) => f.type === "error", 50)).toBe(true);
    });
  }

  test("a malformed authenticate is an auth failure: error unauthorized (correlated), then 4001", async () => {
    const b = boot("auth-malformed");
    const { client } = await connectAndChallenge(b);
    client.send({ id: "cli_bad_auth", type: "authenticate", data: { actor: "alice" } });
    const err = await client.ofType("error");
    expect(err.correlationId).toBe("cli_bad_auth");
    expect(err.data).toMatchObject({ code: "unauthorized", status: 401 });
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  test("an authenticate with no id fails authentication: uncorrelated error, then 4001", async () => {
    const b = boot("auth-no-id");
    const signer = await registerUserWithKey(b, "alice");
    const { client, nonce } = await connectAndChallenge(b);
    sendAuthenticate(client, signer, nonce, { id: "" });
    const err = await client.ofType("error");
    expect(err.correlationId).toBeUndefined();
    expect(err.data).toMatchObject({ code: "unauthorized", status: 401 });
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  test("connection cap: the error too_many_requests replaces authenticated, then close 1013", async () => {
    const b = boot("conn-cap", undefined, { WS_MAX_CONNECTIONS_PER_ACTOR: "1" });
    const signer = await registerUserWithKey(b, "alice");
    const first = await connectAndChallenge(b);
    sendAuthenticate(first.client, signer, first.nonce);
    await first.client.ofType("authenticated");

    const second = await connectAndChallenge(b);
    sendAuthenticate(second.client, signer, second.nonce, { id: "cli_auth_2" });
    const err = await second.client.next();
    expect(err.type).toBe("error");
    expect(err.correlationId).toBe("cli_auth_2");
    expect(err.data).toMatchObject({ code: "too_many_requests", status: 429 });
    await second.client.waitClosed();
    expect(second.client.closeCode).toBe(1013);
    // The first connection is untouched; only it is registered.
    expect(first.client.closed).toBe(false);
    expect(b.hub.liveConnectionCount(signer.actor)).toBe(1);
    first.client.close();
  });
});
