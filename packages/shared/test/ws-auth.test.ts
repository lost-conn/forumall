import { describe, expect, test } from "bun:test";

import {
  WS_AUTHENTICATE_TAG,
  buildWsAuthCanonicalString,
  signWsAuthenticate,
  verifyWsAuthenticate,
} from "../src/ws-auth.ts";

// Reuse the request-signing conformance test key from the ofscp SSOT.
// import.meta.dir = packages/shared/test → up 4 to the personal/ root.
const vectorPath = new URL("../../../../ofscp/tests/signing-vector.json", import.meta.url);
const vector = (await Bun.file(vectorPath).json()) as {
  key: { seed_hex: string; public_key_base64: string };
};

const SEED_HEX = vector.key.seed_hex;
const PUB_B64 = vector.key.public_key_base64;

// Authoritative WS-auth vector inputs (from the WS sample payloads).
const AUTHORITY = "providera.com";
const CHALLENGE_NONCE = "Yz0aF1kP9rT2uV4xZ6bN8cQwE3sH5jL7"; // ws-auth-challenge.sample.json
const TIMESTAMP = "2026-01-01T12:00:01Z"; // ws-authenticate.sample.json

// Deterministic Ed25519 signature for the tuple above. Hardcoded so any
// regression in the canonical-string construction or signing is caught.
const EXPECTED_SIGNATURE =
  "5/oyosSNBdeu39klnsv0HwuAGJnEvA3Y/XG1CXJASSuf/ipyYlg8tYSJQzx2MBe9fXlccurvhGxsK4N6LQPZDA==";

// The placeholder copied into ws-authenticate.sample.json is the request-signing
// vector's signature, which is NOT a valid WS-auth signature.
const PLACEHOLDER_SIGNATURE =
  "5lzq7Ji0hNF8VVG9RhzTbyTQ5rNyYRKuVi6VssT0TPqc23EU+DhZRk/dL0snxLkLtibG2hq5ZhKvoiFlEz7yBg==";

describe("ws-auth canonical string (spec §7.1)", () => {
  test("has exactly 4 LF-joined lines, no trailing newline", () => {
    const cs = buildWsAuthCanonicalString({
      authority: AUTHORITY,
      challengeNonce: CHALLENGE_NONCE,
      timestamp: TIMESTAMP,
    });
    const lines = cs.split("\n");
    expect(lines).toHaveLength(4);
    expect(cs.endsWith("\n")).toBe(false);
  });

  test("line 2 is the fixed literal ofscp-ws-authenticate", () => {
    const cs = buildWsAuthCanonicalString({
      authority: AUTHORITY,
      challengeNonce: CHALLENGE_NONCE,
      timestamp: TIMESTAMP,
    });
    const lines = cs.split("\n");
    expect(lines[1]).toBe("ofscp-ws-authenticate");
    expect(lines[1]).toBe(WS_AUTHENTICATE_TAG);
  });

  test("lines are authority / tag / challengeNonce / timestamp", () => {
    const cs = buildWsAuthCanonicalString({
      authority: AUTHORITY,
      challengeNonce: CHALLENGE_NONCE,
      timestamp: TIMESTAMP,
    });
    expect(cs).toBe(
      "providera.com\nofscp-ws-authenticate\nYz0aF1kP9rT2uV4xZ6bN8cQwE3sH5jL7\n2026-01-01T12:00:01Z",
    );
  });

  test("authority canonicalization: :443 omitted, :8443 kept, host lowercased", () => {
    const lineFor = (authority: string) =>
      buildWsAuthCanonicalString({
        authority,
        challengeNonce: CHALLENGE_NONCE,
        timestamp: TIMESTAMP,
      }).split("\n")[0];
    expect(lineFor("ProviderA.com:443")).toBe("providera.com");
    expect(lineFor("providera.com:8443")).toBe("providera.com:8443");
    expect(lineFor("ProviderA.COM")).toBe("providera.com");
  });
});

describe("ws-auth authoritative vector (stable)", () => {
  test("signature for (providera.com, sample nonce, sample timestamp, test key) is stable", () => {
    const { signature } = signWsAuthenticate({
      privateKey: SEED_HEX,
      authority: AUTHORITY,
      challengeNonce: CHALLENGE_NONCE,
      timestamp: TIMESTAMP,
    });
    expect(signature).toBe(EXPECTED_SIGNATURE);
  });

  test("computed signature differs from the sample placeholder", () => {
    expect(EXPECTED_SIGNATURE).not.toBe(PLACEHOLDER_SIGNATURE);
  });

  test("verify accepts the authoritative signature", () => {
    expect(
      verifyWsAuthenticate({
        publicKey: PUB_B64,
        authority: AUTHORITY,
        challengeNonce: CHALLENGE_NONCE,
        timestamp: TIMESTAMP,
        signature: EXPECTED_SIGNATURE,
      }),
    ).toBe(true);
  });

  test("verify rejects the placeholder signature", () => {
    expect(
      verifyWsAuthenticate({
        publicKey: PUB_B64,
        authority: AUTHORITY,
        challengeNonce: CHALLENGE_NONCE,
        timestamp: TIMESTAMP,
        signature: PLACEHOLDER_SIGNATURE,
      }),
    ).toBe(false);
  });
});

describe("ws-auth round-trip", () => {
  const base = {
    authority: AUTHORITY,
    challengeNonce: CHALLENGE_NONCE,
    timestamp: TIMESTAMP,
  };

  test("sign then verify === true", () => {
    const { signature } = signWsAuthenticate({ privateKey: SEED_HEX, ...base });
    expect(verifyWsAuthenticate({ publicKey: PUB_B64, ...base, signature })).toBe(true);
  });

  test("wrong challenge nonce → verify false", () => {
    const { signature } = signWsAuthenticate({ privateKey: SEED_HEX, ...base });
    expect(
      verifyWsAuthenticate({
        publicKey: PUB_B64,
        ...base,
        challengeNonce: "wrong-nonce-0000000000000000000",
        signature,
      }),
    ).toBe(false);
  });

  test("wrong authority → verify false", () => {
    const { signature } = signWsAuthenticate({ privateKey: SEED_HEX, ...base });
    expect(
      verifyWsAuthenticate({
        publicKey: PUB_B64,
        ...base,
        authority: "evil.com",
        signature,
      }),
    ).toBe(false);
  });

  test("wrong timestamp → verify false", () => {
    const { signature } = signWsAuthenticate({ privateKey: SEED_HEX, ...base });
    expect(
      verifyWsAuthenticate({
        publicKey: PUB_B64,
        ...base,
        timestamp: "2026-01-01T12:00:02Z",
        signature,
      }),
    ).toBe(false);
  });

  test("malformed signature → verify false (never throws)", () => {
    expect(
      verifyWsAuthenticate({
        publicKey: PUB_B64,
        ...base,
        signature: "not-base64-!!!",
      }),
    ).toBe(false);
  });
});
