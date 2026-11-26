/**
 * Problem `type` per provider + the §7.3 errorCode registry (OFSCP §2.6, §7.3;
 * lost-conn/ofscp#17).
 *
 *  - Every problem response's `type` is `https://{this provider's canonical
 *    authority}/problems/{errorCode}` — including a domain with a port, the
 *    unknown-route 404, signature-middleware failures and the generic 500.
 *  - Forumall's registry table matches the spec's §7.3 table verbatim (parsed
 *    from `../ofscp/docs/ofscp_spec.md`), and every `AppError` slug agrees with
 *    it.
 *  - WebSocket `error` events carry a registry `code` with its fixed `status`.
 *  - `GET /problems/{errorCode}` serves a description page for registry codes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  ProblemDetailsSchema,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  signWsAuthenticate,
} from "@forumall/shared";
import { Hono } from "hono";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  AppError,
  ERROR_CODE_REGISTRY,
  PROBLEM_STATUS,
  type RegistryErrorCode,
  createProblemHandlers,
  isRegistryErrorCode,
  problemType,
} from "../src/http/errors.ts";
import type { AppBindings } from "../src/http/types.ts";
import { errorEvent } from "../src/http/ws.ts";
import { OFSCP_REPO } from "./helpers/ofscp-schemas.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-problems-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, domain: string) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN: domain,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { testOnlySkipReplayWarmup: true, db });
  return { app, config, db };
}

describe("problem `type` is minted under the provider's own authority (§2.6)", () => {
  for (const domain of ["providera.test", "localhost:8443", "Social.Example:443"]) {
    // `Social.Example:443` canonicalizes to `social.example` (§2.2).
    const authority = domain === "Social.Example:443" ? "social.example" : domain;

    test(`${domain}: unknown route 404 → https://${authority}/problems/not_found`, async () => {
      const { app } = freshApp(`nf-${authority.replace(/[^a-z0-9]/g, "")}`, domain);
      const res = await app.request("/api/does-not-exist");
      expect(res.status).toBe(404);
      const body = ProblemDetailsSchema.parse(await res.json());
      expect(body.type).toBe(`https://${authority}/problems/not_found`);
      expect(body.errorCode).toBe("not_found");
    });

    test(`${domain}: signature failure 401 → https://${authority}/problems/unauthorized`, async () => {
      const { app } = freshApp(`ua-${authority.replace(/[^a-z0-9]/g, "")}`, domain);
      const res = await app.request("/api/auth/device-keys"); // signed route, no headers
      expect(res.status).toBe(401);
      const body = ProblemDetailsSchema.parse(await res.json());
      expect(body.type).toBe(`https://${authority}/problems/unauthorized`);
      expect(body.errorCode).toBe("unauthorized");
    });
  }

  test("the type never uses a shared base (no ofscp.org)", async () => {
    const { app } = freshApp("noshared", "providera.test");
    const body = (await (await app.request("/api/nope")).json()) as { type: string };
    expect(body.type).not.toContain("ofscp.org");
  });

  test("handlers: AppError and the unknown-error 500 both use the bound authority", async () => {
    const probe = new Hono<AppBindings>();
    probe.get("/conflict", () => {
      throw AppError.conflict({ detail: "x" });
    });
    probe.get("/explode", () => {
      throw new Error("secret");
    });
    probe.onError(createProblemHandlers("localhost:3000").onError);

    const conflict = ProblemDetailsSchema.parse(await (await probe.request("/conflict")).json());
    expect(conflict.type).toBe("https://localhost:3000/problems/conflict");
    const boom = await probe.request("/explode");
    expect(boom.status).toBe(500);
    const body = ProblemDetailsSchema.parse(await boom.json());
    expect(body.type).toBe("https://localhost:3000/problems/internal_error");
    expect(body.errorCode).toBe("internal_error");
  });

  test("problemType uses the errorCode verbatim (extension codes too)", () => {
    expect(problemType("social.example", "not_found")).toBe(
      "https://social.example/problems/not_found",
    );
    expect(problemType("social.example", "invite_expired")).toBe(
      "https://social.example/problems/invite_expired",
    );
  });
});

describe("errorCode registry (§7.3)", () => {
  /** Parse the spec's normative registry table: `| 400 | \`bad_request\` | … |`. */
  function specRegistry(): Record<string, number> {
    const spec = readFileSync(join(OFSCP_REPO, "docs", "ofscp_spec.md"), "utf8");
    const start = spec.indexOf("**Error code registry (Normative).**");
    expect(start).toBeGreaterThan(-1);
    const out: Record<string, number> = {};
    for (const line of spec.slice(start).split("\n").slice(1, 30)) {
      const m = /^\|\s*(\d{3})\s*\|\s*`([a-z_]+)`\s*\|/.exec(line);
      if (m) out[m[2] as string] = Number(m[1]);
    }
    return out;
  }

  test("Forumall's registry equals the spec's table exactly", () => {
    const fromSpec = specRegistry();
    expect(Object.keys(fromSpec).length).toBeGreaterThanOrEqual(10);
    const ours = Object.fromEntries(
      Object.entries(ERROR_CODE_REGISTRY).map(([code, { status }]) => [code, status]),
    );
    expect(ours).toEqual(fromSpec);
  });

  test("every AppError slug carries a registry code with its fixed status", () => {
    for (const [slug, entry] of Object.entries(PROBLEM_STATUS)) {
      expect(isRegistryErrorCode(entry.errorCode)).toBe(true);
      expect({ slug, status: ERROR_CODE_REGISTRY[entry.errorCode].status }).toEqual({
        slug,
        status: entry.status,
      });
      // …and the rendered problem always includes the errorCode (§2.6 MUST).
      const p = new AppError(slug as keyof typeof PROBLEM_STATUS).toProblem("a.test");
      expect(p.errorCode).toBe(entry.errorCode);
      expect(p.status).toBe(entry.status);
    }
  });

  test("a registry errorCode override on the wrong status is refused", () => {
    expect(() => AppError.forbidden({ errorCode: "not_found" })).toThrow(TypeError);
    // Same status (409) is fine; so is an extension code.
    expect(new AppError("conflict", { errorCode: "subscription_limit" }).status).toBe(409);
    expect(AppError.badRequest({ errorCode: "bad_cursor" }).errorCode).toBe("bad_cursor");
  });

  test("WS errorEvent: status is the registry status for every code", () => {
    for (const code of Object.keys(ERROR_CODE_REGISTRY) as RegistryErrorCode[]) {
      const ev = errorEvent(code, "m", "cid");
      expect(ev.data).toEqual({ code, message: "m", status: ERROR_CODE_REGISTRY[code].status });
      expect(ev.correlationId).toBe("cid");
    }
  });
});

describe("GET /problems/{errorCode} (§2.6 SHOULD)", () => {
  test("serves a description page for every registry code", async () => {
    const { app } = freshApp("pages", "providera.test");
    for (const [code, { status }] of Object.entries(ERROR_CODE_REGISTRY)) {
      const res = await app.request(`/problems/${code}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(code);
      expect(html).toContain(String(status));
    }
  });

  test("the URL in a problem's `type` dereferences on this provider", async () => {
    const { app } = freshApp("deref", "providera.test");
    const body = (await (await app.request("/api/nope")).json()) as { type: string };
    const res = await app.request(new URL(body.type).pathname);
    expect(res.status).toBe(200);
  });

  test("unknown code → 404 problem+json", async () => {
    const { app } = freshApp("pages404", "providera.test");
    const res = await app.request("/problems/rate_limited");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

// ---------------------------------------------------------------------------
// WS `error` events over a real socket use registry codes + statuses (§7.3).
// ---------------------------------------------------------------------------

const WS_DOMAIN = "providera.test";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function nextFrame(ws: WebSocket, pred: (f: WsEnvelope) => boolean): Promise<WsEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), 2000);
    const onMsg = (e: MessageEvent) => {
      const f = JSON.parse(String(e.data)) as WsEnvelope;
      if (!pred(f)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(f);
    };
    ws.addEventListener("message", onMsg);
  });
}

function expectRegistryError(f: WsEnvelope, code: RegistryErrorCode): void {
  expect(f.type).toBe("error");
  const data = f.data as { code: string; status: number };
  expect(data.code).toBe(code);
  expect(isRegistryErrorCode(data.code)).toBe(true);
  expect(data.status).toBe(ERROR_CODE_REGISTRY[code].status);
}

describe("WS error events use the §7.3 registry", () => {
  test("bad JSON / bad command / refused subscribe / failed auth", async () => {
    const { app } = freshApp("ws-errors", WS_DOMAIN);
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
    servers.push(server);
    const base = `http://${server.hostname}:${server.port}`;

    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "alice", password: "correct-horse" }),
    });
    const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;
    const { publicKey, privateKey } = generateKeyPair();
    const dk = await fetch(`${base}/api/auth/device-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "d" }),
    });
    const keyId = ((await dk.json()) as { key_id: string }).key_id;

    const open = async () => {
      const ws = new WebSocket(`ws://${server.hostname}:${server.port}/api/ws`);
      const challenge = nextFrame(ws, (f) => f.type === "auth.challenge");
      await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
      return { ws, nonce: ((await challenge).data as { nonce: string }).nonce };
    };
    const authenticate = (ws: WebSocket, nonce: string, key = privateKey) => {
      const timestamp = rfc3339Timestamp();
      const { signature } = signWsAuthenticate({
        privateKey: key,
        authority: WS_DOMAIN,
        challengeNonce: nonce,
        timestamp,
      });
      ws.send(
        JSON.stringify({
          id: "cli_auth",
          type: "authenticate",
          ts: rfc3339Timestamp(),
          data: { actor: `alice@${WS_DOMAIN}`, keyId, timestamp, signature },
        }),
      );
    };

    // Failed authentication → unauthorized / 401.
    {
      const { ws, nonce } = await open();
      const err = nextFrame(ws, (f) => f.type === "error");
      authenticate(ws, nonce, generateKeyPair().privateKey);
      expectRegistryError(await err, "unauthorized");
      ws.close();
    }

    const { ws, nonce } = await open();
    const authed = nextFrame(ws, (f) => f.type === "authenticated");
    authenticate(ws, nonce);
    await authed;

    // Not JSON → bad_request / 400.
    let err = nextFrame(ws, (f) => f.type === "error");
    ws.send("{not json");
    expectRegistryError(await err, "bad_request");

    // Malformed subscribe → bad_request / 400.
    err = nextFrame(ws, (f) => f.type === "error" && f.correlationId === "c1");
    ws.send(JSON.stringify({ id: "c1", type: "subscribe", ts: rfc3339Timestamp(), data: {} }));
    expectRegistryError(await err, "bad_request");

    // Subscribing to a channel we cannot see → not_found / 404 (§7.1, §11.3).
    err = nextFrame(ws, (f) => f.type === "error" && f.correlationId === "c2");
    ws.send(
      JSON.stringify({
        id: "c2",
        type: "subscribe",
        ts: rfc3339Timestamp(),
        data: { channels: ["chn_nope"] },
      }),
    );
    expectRegistryError(await err, "not_found");
    ws.close();
  });
});
