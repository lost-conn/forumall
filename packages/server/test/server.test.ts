/**
 * Integration tests for the P2 provider skeleton.
 *
 * Drives the app in-process via Hono's `app.request(...)` (no real port), uses a
 * temp dir + temp SQLite file per test run, and validates problem+json bodies
 * against the shared `ProblemDetailsSchema`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProblemDetailsSchema,
  ProviderDiscoverySchema,
  TiersResponseSchema,
} from "@forumall/shared";
import { Hono } from "hono";

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { AppError } from "../src/http/errors.ts";
import type { AppBindings } from "../src/http/types.ts";

const PROBLEM_CT = "application/problem+json";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-server-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, overrides: Record<string, string> = {}) {
  const config = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    ...overrides,
  });
  const db = openDb(config.dbPath);
  migrate(db);
  return { app: createApp(config, { db }), config, db };
}

describe("config", () => {
  test("empty env returns all defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(3000);
    expect(c.domain).toBe("localhost:3000");
    expect(c.dataDir).toBe("./data");
    expect(c.dbPath).toBe("data/forumall.sqlite");
    expect(c.mediaDir).toBe("data/media");
  });

  test("PORT override is respected (and flows into default domain)", () => {
    const c = loadConfig({ PORT: "1234" });
    expect(c.port).toBe(1234);
    expect(c.domain).toBe("localhost:1234");
  });

  test("invalid PORT throws", () => {
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow();
  });
});

describe("migrations", () => {
  test("apply cleanly and are idempotent across two runs", () => {
    const db = openDb(join(tmp, "migrate.sqlite"));

    const first = migrate(db);
    expect(first).toContain("0001_app_meta");

    // Running again applies nothing and does not throw.
    const second = migrate(db);
    expect(second).toEqual([]);

    // app_meta table exists and is usable; ledger has exactly one row.
    db.sqlite.exec("INSERT INTO app_meta (key, value, updated_at) VALUES ('k', 'v', 0)");
    const meta = db.sqlite
      .query<{ value: string }, []>("SELECT value FROM app_meta WHERE key = 'k'")
      .get();
    expect(meta?.value).toBe("v");

    const ledger = db.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _migrations")
      .get();
    // One row per shipped migration (app_meta + provider_keys, …).
    expect(ledger?.n).toBe(first.length);
  });
});

describe("error handling (problem+json)", () => {
  test("GET /api/<unknown> -> 404 problem+json with valid body", async () => {
    const { app } = freshApp("notfound");
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CT);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.parse(body);
    expect(parsed.status).toBe(404);
    expect(parsed.errorCode).toBe("not_found");
  });

  test("thrown AppError -> mapped status + problem+json", async () => {
    const { config, db } = freshApp("apperror");
    // Mount a test-only throwing route wired identically to the real app.
    const probe = new Hono<AppBindings>();
    probe.use("*", async (c, next) => {
      c.set("config", config);
      c.set("db", db);
      await next();
    });
    probe.get("/api/boom", () => {
      throw AppError.forbidden({ detail: "nope" });
    });
    const { onError } = await import("../src/http/errors.ts");
    probe.onError(onError);

    const res = await probe.request("/api/boom");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CT);
    const parsed = ProblemDetailsSchema.parse(await res.json());
    expect(parsed.status).toBe(403);
    expect(parsed.errorCode).toBe("forbidden");
    expect(parsed.detail).toBe("nope");
  });

  test("unexpected thrown error -> 500 problem+json with no stack leak", async () => {
    const { config, db } = freshApp("boom500");
    const probe = new Hono<AppBindings>();
    probe.use("*", async (c, next) => {
      c.set("config", config);
      c.set("db", db);
      await next();
    });
    probe.get("/api/explode", () => {
      throw new Error("secret internal detail");
    });
    const { onError } = await import("../src/http/errors.ts");
    probe.onError(onError);

    const res = await probe.request("/api/explode");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CT);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
    const parsed = ProblemDetailsSchema.parse(JSON.parse(text));
    expect(parsed.status).toBe(500);
    expect(parsed.errorCode).toBe("internal_error");
  });
});

describe("api", () => {
  test("GET /api/health returns ok + domain", async () => {
    const { app } = freshApp("health", { PORT: "4321" });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; domain: string };
    expect(body.status).toBe("ok");
    expect(body.domain).toBe("localhost:4321");
  });
});

describe("discovery (§3.1)", () => {
  test("GET /.well-known/ofscp-provider -> 200, validates, no private key", async () => {
    const { app } = freshApp("discovery", { PORT: "5555" });
    const res = await app.request("/.well-known/ofscp-provider");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const text = await res.text();
    // No private *key* material anywhere in the serialized body (the literal
    // "private" tier id is expected, so we check for key field names only).
    expect(text).not.toContain("privateKey");
    expect(text).not.toContain("private_key");

    const body = JSON.parse(text);
    const doc = ProviderDiscoverySchema.parse(body);

    expect(doc.provider.protocolVersion).toBe("0.1.0");
    expect(doc.provider.domain).toBe("localhost:5555");
    expect(doc.provider.publicKeys[0]?.algorithm).toBe("Ed25519");
    expect(doc.provider.publicKeys[0]?.public_key.length).toBeGreaterThan(0);
    expect(doc.provider.software?.name).toBe("forumall");
    expect(doc.provider.authentication.login_endpoint).toBe(
      "https://localhost:5555/api/auth/login",
    );
    expect(doc.capabilities?.tiers).toContain("private");
    expect(doc.capabilities?.limits?.maxUploadBytes).toBe(26_214_400);
    expect(doc.capabilities?.federation?.realtimeDelivery).toBe("direct-ws");

    // No private key field should appear at any nesting level.
    const walk = (v: unknown): void => {
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          expect(k.toLowerCase()).not.toContain("private");
          walk(val);
        }
      }
    };
    walk(body);
  });

  test("cross-checks against the published discovery sample's shape", async () => {
    const samplePath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "ofscp",
      "tests",
      "provider-discovery.sample.json",
    );
    const sample = await Bun.file(samplePath).json();
    // The published sample itself must validate against our shared schema...
    ProviderDiscoverySchema.parse(sample);

    const { app } = freshApp("discovery-sample");
    const res = await app.request("/.well-known/ofscp-provider");
    const ours = await res.json();
    ProviderDiscoverySchema.parse(ours);

    // ...and our output must be structurally consistent (same top-level keys,
    // same provider/capabilities key sets minus optional extras).
    expect(Object.keys(ours).sort()).toEqual(
      expect.arrayContaining(["provider", "capabilities"]),
    );
    for (const k of ["domain", "protocolVersion", "software", "authentication", "publicKeys"]) {
      expect(ours.provider).toHaveProperty(k);
      expect(sample.provider).toHaveProperty(k);
    }
    for (const k of ["messageTypes", "tiers", "limits", "federation", "discovery"]) {
      expect(ours.capabilities).toHaveProperty(k);
      expect(sample.capabilities).toHaveProperty(k);
    }
    expect(ours.provider.publicKeys[0].algorithm).toBe(sample.provider.publicKeys[0].algorithm);
  });

  test("caching headers present on discovery", async () => {
    const { app } = freshApp("discovery-cache");
    const res = await app.request("/.well-known/ofscp-provider");
    expect(res.headers.get("cache-control")).toBeTruthy();
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    // If-None-Match short-circuits to 304.
    const res2 = await app.request("/.well-known/ofscp-provider", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(res2.status).toBe(304);
  });

  test("provider signing key persists across a fresh app on the same db file", async () => {
    const dbPath = join(tmp, "persist-key.sqlite");
    const mk = () => {
      const config = loadConfig({ DATA_DIR: tmp, DB_PATH: dbPath, WEB_DIR: join(tmp, "pk-web") });
      const db = openDb(config.dbPath);
      migrate(db);
      return { app: createApp(config, { db }), db };
    };

    const first = mk();
    const doc1 = ProviderDiscoverySchema.parse(
      await (await first.app.request("/.well-known/ofscp-provider")).json(),
    );
    first.db.sqlite.close();

    // Re-open a fresh app on the SAME db file: the key must be reused.
    const second = mk();
    const doc2 = ProviderDiscoverySchema.parse(
      await (await second.app.request("/.well-known/ofscp-provider")).json(),
    );
    second.db.sqlite.close();

    expect(doc2.provider.publicKeys[0]?.key_id).toBe(doc1.provider.publicKeys[0]?.key_id);
    expect(doc2.provider.publicKeys[0]?.public_key).toBe(doc1.provider.publicKeys[0]?.public_key);
  });
});

describe("tiers (§11.1)", () => {
  test("GET /api/tiers -> 200, validates, includes private", async () => {
    const { app } = freshApp("tiers");
    const res = await app.request("/api/tiers");
    expect(res.status).toBe(200);
    const body = TiersResponseSchema.parse(await res.json());
    const ids = body.tiers.map((t) => t.id);
    expect(ids).toContain("private");
    const priv = body.tiers.find((t) => t.id === "private");
    expect(priv?.name.length).toBeGreaterThan(0);
    expect(typeof priv?.description).toBe("string");
  });
});

describe("static SPA", () => {
  test("non-API route serves index.html from the static dir", async () => {
    const webDir = join(tmp, "spa-web");
    const { app } = freshApp("spa", { WEB_DIR: webDir });
    // Bun.write creates intermediate dirs.
    await Bun.write(join(webDir, "index.html"), "<!doctype html><title>SPA</title>");

    const res = await app.request("/some/spa/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("SPA");
  });

  test("missing web build: non-API route 404s cleanly (problem+json)", async () => {
    const { app } = freshApp("nostatic", {
      WEB_DIR: join(tmp, "definitely-absent"),
    });
    const res = await app.request("/some/spa/route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CT);
    ProblemDetailsSchema.parse(await res.json());
  });

  test("static asset is served when present", async () => {
    const webDir = join(tmp, "asset-web");
    const { app } = freshApp("asset", { WEB_DIR: webDir });
    await Bun.write(join(webDir, "index.html"), "<!doctype html>");
    await Bun.write(join(webDir, "robots.txt"), "User-agent: *");

    const res = await app.request("/robots.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("User-agent");
  });
});
