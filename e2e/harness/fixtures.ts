/**
 * Playwright fixtures (P8 e2e harness — P9 reuses + extends this).
 *
 * Per worker it:
 *   1. builds the web client once (`vite build` → packages/web/dist) — guarded by
 *      a lock so parallel workers build at most once,
 *   2. boots `@forumall/server` on an ephemeral port against a fresh temp
 *      DATA_DIR, serving that dist (via `harness/boot-server.ts` under `bun`),
 *   3. exposes the live base URL as the `appServer` fixture (+ overrides the
 *      Playwright `baseURL` so `page.goto("/")` hits it),
 *   4. tears the server down and removes the temp dir afterwards.
 *
 * The single-provider auth test consumes `appServer.baseUrl`. A future
 * multi-provider (federation) test can request two `bootServer()` instances.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const WEB_DIR = join(REPO_ROOT, "packages", "web", "dist");
const BOOT_SCRIPT = join(HERE, "boot-server.ts");

/** A booted provider instance. */
export interface BootedServer {
  baseUrl: string;
  port: number;
  stop: () => void;
}

let webBuilt = false;
/** Build the web client once per process. */
function ensureWebBuilt(): void {
  if (webBuilt) return;
  // Always (re)build so the served dist reflects the current source.
  const res = spawnSync("bun", ["run", "--filter", "@forumall/web", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`web build failed (exit ${res.status})`);
  }
  if (!existsSync(join(WEB_DIR, "index.html"))) {
    throw new Error(`web build did not produce ${WEB_DIR}/index.html`);
  }
  webBuilt = true;
}

/** Boot one ephemeral server serving the built web client; resolves when ready. */
export function bootServer(): Promise<BootedServer> {
  ensureWebBuilt();
  const dataDir = mkdtempSync(join(tmpdir(), "forumall-e2e-"));

  return new Promise<BootedServer>((resolveReady, rejectReady) => {
    const child: ChildProcess = spawn("bun", [BOOT_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        WEB_DIR,
        // Short WS heartbeat/idle so the presence e2e observes disconnect→offline
        // quickly even on an ungraceful drop (a clean close is immediate anyway).
        WS_PING_INTERVAL_MS: process.env.WS_PING_INTERVAL_MS ?? "1000",
        WS_IDLE_TIMEOUT_MS: process.env.WS_IDLE_TIMEOUT_MS ?? "3000",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });

    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
      rejectReady(new Error("server did not become ready within 30s"));
    }, 30_000);

    const stop = () => {
      clearTimeout(timeout);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      rmSync(dataDir, { recursive: true, force: true });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((l) => l.startsWith("__READY__"));
      if (line && !settled) {
        settled = true;
        clearTimeout(timeout);
        const json = JSON.parse(line.slice("__READY__".length).trim()) as {
          port: number;
          baseUrl: string;
        };
        resolveReady({ baseUrl: json.baseUrl, port: json.port, stop });
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rmSync(dataDir, { recursive: true, force: true });
        rejectReady(new Error(`server exited before ready (code ${code})`));
      }
    });
  });
}

interface Fixtures {
  appServer: BootedServer;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature.
  appServer: async ({}, use) => {
    const server = await bootServer();
    await use(server);
    server.stop();
  },
  baseURL: async ({ appServer }, use) => {
    await use(appServer.baseUrl);
  },
});

export { expect } from "@playwright/test";
