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
import { ProblemDetailsSchema } from "@forumall/shared";
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
    expect(ledger?.n).toBe(1);
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
