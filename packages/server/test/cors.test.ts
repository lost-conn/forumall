/**
 * Cross-origin access (spec §3.4) on a real server: preflights to standard
 * `/api/…` and `/.well-known/ofscp…` paths, the headers on ordinary, error
 * (problem+json) and attachment responses to a request with `Origin`, never
 * `Access-Control-Allow-Credentials`, and a WebSocket upgrade with a foreign
 * `Origin` that still connects and authenticates (§3.4/§7.1: no Origin check).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Attachment,
  AttachmentSchema,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
} from "@forumall/shared";

import { addVaryOrigin } from "../src/http/cors.ts";
import { uploadMedia } from "./helpers/media-upload.ts";
import {
  type Booted,
  DOMAIN,
  type Signer,
  boot,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";
import { RawWsClient } from "./helpers/raw-ws.ts";

const ORIGIN = "https://client.elsewhere.example";

/** §3.4: the preflight's `Access-Control-Allow-Headers` must include at least these. */
const REQUIRED_ALLOW_HEADERS = [
  "content-type",
  "accept",
  "authorization",
  "x-ofscp-actor",
  "x-ofscp-provider",
  "x-ofscp-key-id",
  "x-ofscp-timestamp",
  "x-ofscp-nonce",
  "x-ofscp-content-digest",
  "x-ofscp-signature",
];
/** §3.4: the expose list is the allow list plus `Retry-After` and `ETag`. */
const REQUIRED_EXPOSE_HEADERS = [...REQUIRED_ALLOW_HEADERS, "retry-after", "etag"];

let tmp: string;
let b: Booted;
let alice: Signer;

function url(path: string): string {
  return `http://${b.server.hostname}:${b.server.port}${path}`;
}

/** A header's comma-separated list, lower-cased. */
function listOf(res: Response, name: string): string[] {
  return (res.headers.get(name) ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-cors-"));
  b = boot(tmp, "p");
  alice = await registerUserWithKey(b, "alice");
});
afterAll(() => {
  b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

/** Assert the §3.4 headers of a response to a (non-preflight) request with `Origin`. */
function expectCorsResponse(res: Response): void {
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(listOf(res, "access-control-expose-headers")).toEqual(
    expect.arrayContaining(REQUIRED_EXPOSE_HEADERS),
  );
  expect(listOf(res, "vary")).toContain("origin");
  expect(res.headers.has("access-control-allow-credentials")).toBe(false);
}

describe("preflight (§3.4)", () => {
  const preflightTargets: readonly (readonly [string, string])[] = [
    ["POST", "/api/groups/grp_x/channels/ch_y/messages"],
    ["PATCH", "/api/groups/grp_x"],
    ["DELETE", "/api/me/dms/dm_x/messages/m_1"],
    ["GET", "/.well-known/ofscp-provider"],
    ["GET", "/.well-known/ofscp/users/alice/keys"],
  ];

  for (const [method, path] of preflightTargets) {
    test(`OPTIONS ${path} (for ${method}) → 204 with the exact allow set`, async () => {
      const res = await fetch(url(path), {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": method,
          "access-control-request-headers": "content-type, x-ofscp-signature, x-ofscp-actor",
        },
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      expect(listOf(res, "access-control-allow-headers")).toEqual(
        expect.arrayContaining(REQUIRED_ALLOW_HEADERS),
      );
      expect(res.headers.get("access-control-max-age")).toBe("600");
      expect(res.headers.has("access-control-allow-credentials")).toBe(false);
    });
  }

  test("an OPTIONS without Access-Control-Request-Method is not a preflight", async () => {
    const res = await fetch(url("/api/groups"), { method: "OPTIONS", headers: { origin: ORIGIN } });
    expect(res.status).not.toBe(204);
    expect(res.headers.has("access-control-allow-methods")).toBe(false);
    expectCorsResponse(res);
  });
});

describe("responses to a request with Origin (§3.4)", () => {
  test("a success: discovery", async () => {
    const res = await fetch(url("/.well-known/ofscp-provider"), { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    expectCorsResponse(res);
  });

  test("a signed success: a standard /api endpoint", async () => {
    const path = "/api/groups";
    const body = JSON.stringify({ name: "G", tier: "public" });
    const { headers } = sign({
      actor: alice.actor,
      keyId: alice.keyId,
      privateKey: alice.privateKey,
      authority: DOMAIN,
      method: "POST",
      path,
      body,
    });
    const res = await fetch(url(path), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", origin: ORIGIN },
      body,
    });
    expect(res.status).toBe(201);
    expectCorsResponse(res);
  });

  test("a not-found problem on a standard path", async () => {
    const res = await signedReq(b, alice, "GET", "/api/groups/grp_missing");
    expect(res.status).toBe(404);
    const withOrigin = await fetch(url("/api/groups/grp_missing"), { headers: { origin: ORIGIN } });
    expect(withOrigin.status).toBe(404);
    expectCorsResponse(withOrigin);
  });

  test("an error problem response (401) carries them too", async () => {
    const res = await fetch(url("/api/me/dms"), { headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expectCorsResponse(res);
  });

  test("an attachment GET, and its 304", async () => {
    const up = await uploadMedia(
      { request: (p, init) => fetch(url(p), init) },
      alice,
      new TextEncoder().encode("x"),
      "x.txt",
      "text/plain",
    );
    expect(up.status).toBe(201);
    const att: Attachment = AttachmentSchema.parse(await up.json());
    const path = new URL(att.url).pathname;

    const res = await fetch(url(path), { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    expectCorsResponse(res);

    const revalidated = await fetch(url(path), {
      headers: { origin: ORIGIN, "if-none-match": `"${att.hash}"` },
    });
    expect(revalidated.status).toBe(304);
    expectCorsResponse(revalidated);
  });

  test("a request without Origin gets no CORS headers", async () => {
    const res = await fetch(url("/.well-known/ofscp-provider"));
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
  });
});

describe("Vary: Origin is added, never overwriting", () => {
  test("addVaryOrigin", () => {
    const cases: readonly (readonly [string | null, string])[] = [
      [null, "Origin"],
      ["", "Origin"],
      ["Accept-Encoding", "Accept-Encoding, Origin"],
      ["accept-encoding, origin", "accept-encoding, origin"],
      ["*", "*"],
    ];
    for (const [before, after] of cases) {
      const h = new Headers(before === null ? {} : { vary: before });
      addVaryOrigin(h);
      expect(h.get("vary")).toBe(after);
    }
  });
});

describe("WebSocket upgrade (§3.4/§7.1)", () => {
  test("a foreign Origin is upgraded (101) and the handshake authenticates", async () => {
    const client = await RawWsClient.open(
      b.server.hostname ?? "localhost",
      b.server.port ?? 0,
      "/api/ws",
      {
        origin: ORIGIN,
      },
    );
    try {
      expect(client.upgrade.status).toBe(101);
      expect(client.upgrade.acceptValid).toBe(true);
      const challenge = await client.ofType("auth.challenge");
      const nonce = (challenge.data as { nonce: string }).nonce;
      const timestamp = rfc3339Timestamp();
      const { signature } = signWsAuthenticate({
        privateKey: alice.privateKey,
        authority: DOMAIN,
        challengeNonce: nonce,
        timestamp,
      });
      client.send({
        id: "cli_auth",
        type: "authenticate",
        ts: rfc3339Timestamp(),
        data: { actor: alice.actor, keyId: alice.keyId, timestamp, signature },
      });
      const authed = await client.ofType("authenticated");
      expect((authed.data as { actor: string }).actor).toBe(alice.actor);
    } finally {
      client.close();
    }
  });
});
