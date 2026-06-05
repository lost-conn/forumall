import { describe, expect, test } from "bun:test";
import {
  EMPTY_BODY_DIGEST,
  HEADER,
  buildCanonicalString,
  canonicalAuthority,
  canonicalQuery,
  contentDigest,
  generateNonce,
  publicKeyFromPrivate,
  rfc3339Timestamp,
  sign,
  signProvider,
  verify,
  verifyHeaders,
  verifyProviderHeaders,
} from "../src/signing.ts";

// Read the conformance vector from the ofscp SSOT (do not copy it in).
// import.meta.dir = packages/shared/test → up 4 to the personal/ root.
const vectorPath = new URL("../../../../ofscp/tests/signing-vector.json", import.meta.url);
const vector = (await Bun.file(vectorPath).json()) as {
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

const SEED_HEX = vector.key.seed_hex;
const PUB_B64 = vector.key.public_key_base64;

describe("conformance vector (byte-exact)", () => {
  const parts = {
    authority: vector.request.authority,
    method: vector.request.method,
    path: vector.request.path,
    query: vector.request.query,
    timestamp: vector.headers["X-OFSCP-Timestamp"],
    nonce: vector.headers["X-OFSCP-Nonce"],
    contentDigest: vector.headers["X-OFSCP-Content-Digest"],
  };

  test("public key derives from the seed", () => {
    expect(publicKeyFromPrivate(SEED_HEX)).toBe(PUB_B64);
  });

  test("content digest matches the fixture", () => {
    expect(contentDigest(vector.request.body)).toBe(vector.headers["X-OFSCP-Content-Digest"]);
  });

  test("canonical string === fixture canonical_string", () => {
    expect(buildCanonicalString(parts)).toBe(vector.canonical_string);
  });

  test("canonical string is 7 LF-joined lines with no trailing newline", () => {
    const cs = buildCanonicalString(parts);
    expect(cs.split("\n")).toHaveLength(7);
    expect(cs.endsWith("\n")).toBe(false);
  });

  test("signature === fixture expected.signature", () => {
    const { headers } = sign({
      privateKey: SEED_HEX,
      keyId: vector.headers["X-OFSCP-Key-ID"],
      actor: vector.headers["X-OFSCP-Actor"],
      authority: vector.request.authority,
      method: vector.request.method,
      path: vector.request.path,
      query: vector.request.query,
      body: vector.request.body,
      timestamp: vector.headers["X-OFSCP-Timestamp"],
      nonce: vector.headers["X-OFSCP-Nonce"],
    });
    expect(headers[HEADER.SIGNATURE]).toBe(vector.expected.signature);
  });

  test("verify accepts the fixture signature", () => {
    expect(
      verify({
        publicKey: PUB_B64,
        ...parts,
        signature: vector.expected.signature,
      }),
    ).toBe(true);
  });
});

describe("content digest", () => {
  test("empty body digest constant", () => {
    expect(EMPTY_BODY_DIGEST).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    expect(contentDigest("")).toBe(EMPTY_BODY_DIGEST);
    expect(contentDigest(new Uint8Array(0))).toBe(EMPTY_BODY_DIGEST);
  });
});

describe("canonical query", () => {
  test("multiple params are sorted ascending by byte order", () => {
    expect(canonicalQuery("foo=1&bar=2&baz=3")).toBe("bar=2&baz=3&foo=1");
    // Out-of-order array form, with leading '?' stripped from string form.
    expect(canonicalQuery(["z=1", "a=2", "m=3"])).toBe("a=2&m=3&z=1");
    expect(canonicalQuery("?b=2&a=1")).toBe("a=1&b=2");
  });

  test("byte-order sort distinguishes case and value", () => {
    // Uppercase letters (0x41-) sort before lowercase (0x61-).
    expect(canonicalQuery("a=1&A=2")).toBe("A=2&a=1");
    expect(canonicalQuery("foo=2&foo=1")).toBe("foo=1&foo=2");
  });

  test("no query produces an empty line; 7-line shape preserved", () => {
    expect(canonicalQuery(undefined)).toBe("");
    expect(canonicalQuery("")).toBe("");
    const cs = buildCanonicalString({
      authority: "a.com",
      method: "GET",
      path: "/x",
      query: undefined,
      timestamp: "2026-01-01T00:00:00Z",
      nonce: "n",
      contentDigest: EMPTY_BODY_DIGEST,
    });
    const lines = cs.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[3]).toBe(""); // the query line is present but empty
  });
});

describe("canonical authority", () => {
  test("default port 443 is omitted", () => {
    expect(canonicalAuthority("Provider.com:443")).toBe("provider.com");
    expect(canonicalAuthority("provider.com")).toBe("provider.com");
  });

  test("non-default port is included", () => {
    expect(canonicalAuthority("provider.com:8443")).toBe("provider.com:8443");
  });

  test("host is lowercased", () => {
    expect(canonicalAuthority("ProviderA.COM")).toBe("providera.com");
  });
});

describe("path normalization", () => {
  test("empty path becomes /", () => {
    const cs = buildCanonicalString({
      authority: "a.com",
      method: "GET",
      path: "",
      timestamp: "t",
      nonce: "n",
      contentDigest: EMPTY_BODY_DIGEST,
    });
    expect(cs.split("\n")[2]).toBe("/");
  });

  test("path is not collapsed or trailing-slash normalized", () => {
    const cs = buildCanonicalString({
      authority: "a.com",
      method: "GET",
      path: "/a/../b/./c/",
      timestamp: "t",
      nonce: "n",
      contentDigest: EMPTY_BODY_DIGEST,
    });
    expect(cs.split("\n")[2]).toBe("/a/../b/./c/");
  });
});

describe("helpers", () => {
  test("rfc3339Timestamp is UTC, seconds precision, Z-suffixed", () => {
    const ts = rfc3339Timestamp(new Date("2026-01-01T12:00:00.789Z"));
    expect(ts).toBe("2026-01-01T12:00:00Z");
    expect(rfc3339Timestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("generateNonce yields ≥128-bit base64url, unique each call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 24 bytes → 32 base64url chars (no padding).
    expect(a.length).toBeGreaterThanOrEqual(22); // ≥128 bits
  });
});

describe("round-trip (user-signed)", () => {
  const base = {
    privateKey: SEED_HEX,
    keyId: "dk_1",
    actor: "alice@a.com",
    authority: "a.com",
    method: "POST",
    path: "/api/x",
    query: "b=2&a=1",
    body: '{"hello":"world"}',
  };

  test("sign then verifyHeaders === true", () => {
    const { headers } = sign(base);
    expect(
      verifyHeaders({
        publicKey: PUB_B64,
        authority: base.authority,
        method: base.method,
        path: base.path,
        query: base.query,
        headers,
      }),
    ).toBe(true);
  });

  test("tampering with body makes verify false", () => {
    const { headers } = sign(base);
    // recompute digest as the verifier would for a different body → mismatch
    expect(
      verifyHeaders({
        publicKey: PUB_B64,
        authority: base.authority,
        method: base.method,
        path: base.path,
        query: base.query,
        headers: { ...headers, [HEADER.CONTENT_DIGEST]: contentDigest("tampered") },
      }),
    ).toBe(false);
  });

  test("tampering with path makes verify false", () => {
    const { headers } = sign(base);
    expect(
      verifyHeaders({
        publicKey: PUB_B64,
        authority: base.authority,
        method: base.method,
        path: "/api/y",
        query: base.query,
        headers,
      }),
    ).toBe(false);
  });

  test("tampering with authority makes verify false", () => {
    const { headers } = sign(base);
    expect(
      verifyHeaders({
        publicKey: PUB_B64,
        authority: "evil.com",
        method: base.method,
        path: base.path,
        query: base.query,
        headers,
      }),
    ).toBe(false);
  });

  test("tampering with query makes verify false", () => {
    const { headers } = sign(base);
    expect(
      verifyHeaders({
        publicKey: PUB_B64,
        authority: base.authority,
        method: base.method,
        path: base.path,
        query: "a=1&b=3",
        headers,
      }),
    ).toBe(false);
  });

  test("missing signing header makes verifyHeaders false", () => {
    const { headers } = sign(base);
    const { [HEADER.SIGNATURE]: _omit, ...rest } = headers;
    expect(
      verifyHeaders({
        publicKey: PUB_B64,
        authority: base.authority,
        method: base.method,
        path: base.path,
        query: base.query,
        headers: rest,
      }),
    ).toBe(false);
  });
});

describe("provider-signed (§8.1)", () => {
  const base = {
    privateKey: SEED_HEX,
    keyId: "pk_1",
    provider: "providera.com",
    authority: "providerb.com",
    method: "POST",
    path: "/api/deliver",
    body: '{"event":"message.created"}',
  };

  test("signProvider sets X-OFSCP-Provider, not X-OFSCP-Actor", () => {
    const { headers } = signProvider(base);
    expect(headers[HEADER.PROVIDER]).toBe("providera.com");
    expect(headers[HEADER.ACTOR]).toBeUndefined();
    expect(headers[HEADER.SIGNATURE]).toBeTruthy();
  });

  test("round-trips via verifyProviderHeaders", () => {
    const { headers } = signProvider(base);
    expect(
      verifyProviderHeaders({
        publicKey: PUB_B64,
        authority: base.authority,
        method: base.method,
        path: base.path,
        headers,
      }),
    ).toBe(true);
  });

  test("provider canonical string equals the user one for the same target", () => {
    const ts = "2026-01-01T00:00:00Z";
    const nonce = "abc";
    const user = sign({
      privateKey: SEED_HEX,
      keyId: "k",
      actor: "x@a.com",
      authority: "a.com",
      method: "GET",
      path: "/p",
      timestamp: ts,
      nonce,
    });
    const prov = signProvider({
      privateKey: SEED_HEX,
      keyId: "k",
      provider: "a.com",
      authority: "a.com",
      method: "GET",
      path: "/p",
      timestamp: ts,
      nonce,
    });
    expect(prov.canonicalString).toBe(user.canonicalString);
    expect(prov.headers[HEADER.SIGNATURE]).toBe(user.headers[HEADER.SIGNATURE]);
  });
});
