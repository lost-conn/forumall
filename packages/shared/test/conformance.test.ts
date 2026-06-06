/**
 * P9 conformance suite — golden-vector assertions (§4.4, §7.1, §7.4).
 *
 * A single, clearly-named place where a reviewer can confirm the shared impl
 * reproduces every published OFSCP v0.1 conformance vector BYTE-FOR-BYTE. These
 * assertions overlap with the focused unit suites (`signing.test.ts`,
 * `ws-auth.test.ts`, `dm.test.ts`) on purpose: this file is the canonical index
 * of "the spec's vectors are met", so the proof lives in one greppable spot.
 *
 * Vectors are read from the sibling `ofscp` repo (SSOT) where they're published;
 * the WS-authenticate vector is computed against the published challenge/auth
 * sample inputs (no `ws-signing-vector.json` exists upstream yet).
 */
import { describe, expect, test } from "bun:test";

import { deriveDmId } from "../src/dm.ts";
import { HEADER, buildCanonicalString, contentDigest, sign, verify } from "../src/signing.ts";
import {
  buildWsAuthCanonicalString,
  signWsAuthenticate,
  verifyWsAuthenticate,
} from "../src/ws-auth.ts";

// ---------------------------------------------------------------------------
// Request-signing vector (§4.4.2) — published at ofscp/tests/signing-vector.json
// ---------------------------------------------------------------------------

const vectorPath = new URL("../../../../ofscp/tests/signing-vector.json", import.meta.url);
const signingVector = (await Bun.file(vectorPath).json()) as {
  key: { seed_hex: string; public_key_base64: string };
  request: { authority: string; method: string; path: string; query: string; body: string };
  headers: {
    "X-OFSCP-Actor": string;
    "X-OFSCP-Key-ID": string;
    "X-OFSCP-Timestamp": string;
    "X-OFSCP-Nonce": string;
    "X-OFSCP-Content-Digest": string;
  };
  canonical_string: string;
  expected: { signature: string };
};

describe("CONFORMANCE: request-signing vector (§4.4.2, byte-for-byte)", () => {
  const parts = {
    authority: signingVector.request.authority,
    method: signingVector.request.method,
    path: signingVector.request.path,
    query: signingVector.request.query,
    timestamp: signingVector.headers["X-OFSCP-Timestamp"],
    nonce: signingVector.headers["X-OFSCP-Nonce"],
    contentDigest: signingVector.headers["X-OFSCP-Content-Digest"],
  };

  test("content digest === ofscp/tests/signing-vector.json X-OFSCP-Content-Digest", () => {
    expect(contentDigest(signingVector.request.body)).toBe(
      signingVector.headers["X-OFSCP-Content-Digest"],
    );
  });

  test("canonical string === ofscp/tests/signing-vector.json canonical_string", () => {
    expect(buildCanonicalString(parts)).toBe(signingVector.canonical_string);
  });

  test("Ed25519 signature === ofscp/tests/signing-vector.json expected.signature", () => {
    const { headers } = sign({
      privateKey: signingVector.key.seed_hex,
      keyId: signingVector.headers["X-OFSCP-Key-ID"],
      actor: signingVector.headers["X-OFSCP-Actor"],
      authority: signingVector.request.authority,
      method: signingVector.request.method,
      path: signingVector.request.path,
      query: signingVector.request.query,
      body: signingVector.request.body,
      timestamp: signingVector.headers["X-OFSCP-Timestamp"],
      nonce: signingVector.headers["X-OFSCP-Nonce"],
    });
    expect(headers[HEADER.SIGNATURE]).toBe(signingVector.expected.signature);
    expect(
      verify({
        publicKey: signingVector.key.public_key_base64,
        ...parts,
        signature: signingVector.expected.signature,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS-authenticate vector (§7.1) — computed against the published WS samples.
// ---------------------------------------------------------------------------

// Inputs from ofscp/tests/ws-auth-challenge.sample.json + ws-authenticate.sample.json.
const WS_AUTHORITY = "providera.com";
const WS_CHALLENGE_NONCE = "Yz0aF1kP9rT2uV4xZ6bN8cQwE3sH5jL7";
const WS_TIMESTAMP = "2026-01-01T12:00:01Z";
// Deterministic Ed25519 signature for the tuple above under the test key — the
// authoritative WS-auth vector value (kept in lockstep with ws-auth.test.ts).
const WS_EXPECTED_SIGNATURE =
  "5/oyosSNBdeu39klnsv0HwuAGJnEvA3Y/XG1CXJASSuf/ipyYlg8tYSJQzx2MBe9fXlccurvhGxsK4N6LQPZDA==";

describe("CONFORMANCE: WS-authenticate vector (§7.1, byte-for-byte)", () => {
  test("canonical string is the 4-line authority/tag/nonce/timestamp tuple", () => {
    expect(
      buildWsAuthCanonicalString({
        authority: WS_AUTHORITY,
        challengeNonce: WS_CHALLENGE_NONCE,
        timestamp: WS_TIMESTAMP,
      }),
    ).toBe(
      "providera.com\nofscp-ws-authenticate\nYz0aF1kP9rT2uV4xZ6bN8cQwE3sH5jL7\n2026-01-01T12:00:01Z",
    );
  });

  test("signature is the stable authoritative WS-auth vector value", () => {
    const { signature } = signWsAuthenticate({
      privateKey: signingVector.key.seed_hex,
      authority: WS_AUTHORITY,
      challengeNonce: WS_CHALLENGE_NONCE,
      timestamp: WS_TIMESTAMP,
    });
    expect(signature).toBe(WS_EXPECTED_SIGNATURE);
    expect(
      verifyWsAuthenticate({
        publicKey: signingVector.key.public_key_base64,
        authority: WS_AUTHORITY,
        challengeNonce: WS_CHALLENGE_NONCE,
        timestamp: WS_TIMESTAMP,
        signature: WS_EXPECTED_SIGNATURE,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dmId vector (§7.4) — alice@a.com + bob@b.com → published hash.
// ---------------------------------------------------------------------------

describe("CONFORMANCE: dmId derivation vector (§7.4)", () => {
  test("deriveDmId('alice@a.com','bob@b.com') === the published §7.4 hash", () => {
    expect(deriveDmId("alice@a.com", "bob@b.com")).toBe(
      "dm_c2a3a0d4bc7aa54700d2f412c42fc0155df6071e502977e4988933eef7e46868",
    );
  });

  test("is order-independent (same hash for the reversed pair)", () => {
    expect(deriveDmId("bob@b.com", "alice@a.com")).toBe(
      "dm_c2a3a0d4bc7aa54700d2f412c42fc0155df6071e502977e4988933eef7e46868",
    );
  });
});
