/**
 * Env-driven server configuration.
 *
 * Self-host requirement: the provider MUST boot with **no env vars set**. Every
 * value has a sensible default, so `bun run src/index.ts` works out of the box
 * and writes its state under `./data`. All values are parsed/validated with Zod
 * and exposed as a typed, immutable {@link Config}.
 */
import { join } from "node:path";
import { z } from "zod";

/** Coerce a possibly-undefined env string into a positive int port. */
const PortSchema = z.coerce.number().int().min(1).max(65535);

const RawEnvSchema = z.object({
  PORT: PortSchema.default(3000),
  /**
   * Public authority for this provider (used later as the OFSCP signing
   * authority / `iss`). Defaults to `localhost:<PORT>` once PORT is known.
   */
  DOMAIN: z.string().min(1).optional(),
  /** Root directory for all server-owned state (db + media). */
  DATA_DIR: z.string().min(1).default("./data"),
  /** Override for the media directory; defaults to `${DATA_DIR}/media`. */
  MEDIA_DIR: z.string().min(1).optional(),
  /** Override for the sqlite file; defaults to `${DATA_DIR}/forumall.sqlite`. */
  DB_PATH: z.string().min(1).optional(),
});

/** Fully-resolved, validated server configuration. */
export interface Config {
  readonly port: number;
  readonly domain: string;
  readonly dataDir: string;
  readonly mediaDir: string;
  readonly dbPath: string;
  /**
   * Directory of the built web client served as static for non-API routes.
   * Configurable so tests can point it at a temp dir; if it does not exist the
   * app still boots (static routes just 404).
   */
  readonly webDir: string;
}

/** A loosely-typed environment bag (process.env shape). */
export type Env = Record<string, string | undefined>;

/**
 * Load and validate configuration from an environment bag (defaults to
 * `process.env`). Returns a frozen {@link Config} with all defaults applied.
 *
 * @throws ZodError if a provided value is invalid (e.g. a non-numeric PORT).
 */
export function loadConfig(env: Env = process.env): Config {
  const raw = RawEnvSchema.parse(env);

  const dataDir = raw.DATA_DIR;
  const mediaDir = raw.MEDIA_DIR ?? join(dataDir, "media");
  const dbPath = raw.DB_PATH ?? join(dataDir, "forumall.sqlite");
  const domain = raw.DOMAIN ?? `localhost:${raw.PORT}`;
  // The web build lives next to the server package; resolved relative to the
  // monorepo's `packages/` so it works regardless of CWD.
  const webDir = env.WEB_DIR ?? join(import.meta.dir, "..", "..", "web", "dist");

  return Object.freeze({
    port: raw.PORT,
    domain,
    dataDir,
    mediaDir,
    dbPath,
    webDir,
  });
}
