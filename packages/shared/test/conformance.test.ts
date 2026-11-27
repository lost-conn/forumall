/**
 * P9 conformance suite — golden-vector assertions (§4.4, §7.1, §7.4).
 *
 * A single, clearly-named place where a reviewer can confirm the shared impl
 * reproduces every published OFSCP v0.1 conformance vector BYTE-FOR-BYTE. These
 * assertions overlap with the focused unit suites (`signing.test.ts`,
 * `ws-auth.test.ts`, `dm.test.ts`) on purpose: this file is the canonical index
 * of "the spec's vectors are met", so the proof lives in one greppable spot.
 *
 * Vectors are read from the sibling `ofscp` repo (SSOT): the request-signing
 * vector (`tests/signing-vector.json`) and the WS-authenticate vector
 * (`tests/ws-signing-vector.json`). The dmId hash is the one printed in §7.4.
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
// WS-authenticate vector (§7.1) — published at ofscp/tests/ws-signing-vector.json
// ---------------------------------------------------------------------------

const wsVectorPath = new URL("../../../../ofscp/tests/ws-signing-vector.json", import.meta.url);
const wsVector = (await Bun.file(wsVectorPath).json()) as {
  algorithm: string;
  key: { seed_hex: string; public_key_base64: string };
  challenge: { authority: string; challengeNonce: string; timestamp: string };
  canonical_string: string;
  canonical_string_lines: string[];
  expected: { signature: string };
};

describe("CONFORMANCE: WS-authenticate vector (§7.1, byte-for-byte)", () => {
  test("the vector is an Ed25519 vector", () => {
    expect(wsVector.algorithm).toBe("Ed25519");
  });

  test("canonical string === ofscp/tests/ws-signing-vector.json canonical_string", () => {
    const canonical = buildWsAuthCanonicalString(wsVector.challenge);
    expect(canonical).toBe(wsVector.canonical_string);
    // LF-joined lines, no trailing newline.
    expect(canonical.split("\n")).toEqual(wsVector.canonical_string_lines);
  });

  test("the authority is canonicalized as §4.4.2 (case, default :443)", () => {
    const { authority, challengeNonce, timestamp } = wsVector.challenge;
    expect(
      buildWsAuthCanonicalString({
        authority: `${authority.toUpperCase()}:443`,
        challengeNonce,
        timestamp,
      }),
    ).toBe(wsVector.canonical_string);
  });

  test("Ed25519 signature === ofscp/tests/ws-signing-vector.json expected.signature", () => {
    const { signature, canonicalString } = signWsAuthenticate({
      privateKey: wsVector.key.seed_hex,
      ...wsVector.challenge,
    });
    expect(canonicalString).toBe(wsVector.canonical_string);
    expect(signature).toBe(wsVector.expected.signature);
    expect(
      verifyWsAuthenticate({
        publicKey: wsVector.key.public_key_base64,
        ...wsVector.challenge,
        signature: wsVector.expected.signature,
      }),
    ).toBe(true);
  });

  test("the published signature does not verify for another challenge nonce", () => {
    expect(
      verifyWsAuthenticate({
        publicKey: wsVector.key.public_key_base64,
        ...wsVector.challenge,
        challengeNonce: `${wsVector.challenge.challengeNonce}x`,
        signature: wsVector.expected.signature,
      }),
    ).toBe(false);
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
