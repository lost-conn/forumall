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
  /**
   * Maximum attachment upload size in bytes, advertised in discovery as
   * `capabilities.limits.maxUploadBytes` (§3.1, §6) and enforced on upload.
   * Defaults to 25 MiB.
   */
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(0).default(26_214_400),
  /**
   * Optional admin contact published in discovery (`provider.contact`), e.g.
   * `mailto:admin@example.social`. Omitted from the document if unset.
   */
  CONTACT: z.string().min(1).optional(),

  // --- Argon2id password-hashing cost (§4.1.4) ----------------------------
  // Secure-by-default: the defaults equal the spec MINIMUMS, and the schema
  // refuses to go below them. Operators may raise (never lower) the cost.
  /** Argon2id memory cost in KiB. Default + minimum 65536 (= 64 MiB, §4.1.4). */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(65_536).default(65_536),
  /** Argon2id iterations (time cost). Default + minimum 3 (§4.1.4). */
  ARGON2_ITERATIONS: z.coerce.number().int().min(3).default(3),
  /** Argon2id parallelism. Default + minimum 4 (§4.1.4). */
  ARGON2_PARALLELISM: z.coerce.number().int().min(4).default(4),

  /**
   * Bootstrap-token TTL in seconds (§4.2). RECOMMENDED 300. Configurable so
   * tests can use a tiny TTL to exercise expiry; defaults to 300.
   */
  BOOTSTRAP_TTL_SECONDS: z.coerce.number().int().min(1).default(300),

  /**
   * `cache_until` window for the public keys endpoint (§4.6) in seconds. The
   * spec recommends keeping this short to bound revocation latency (§4.7.1,
   * ≤1 hour); default 3600. Capped at 1 hour so an operator cannot accidentally
   * make stale revocations linger.
   */
  USER_KEYS_CACHE_SECONDS: z.coerce.number().int().min(1).max(3600).default(3600),

  /**
   * Message edit window in seconds (§5.3, §7.1): how long after creation a
   * message remains editable, surfaced as `permissions.editUntil`. The WS
   * edit card enforces this; the store stamps `edit_until` at create time.
   * Default 900 (15 min); configurable so tests can use a tiny/large window.
   */
  MESSAGE_EDIT_WINDOW_SECONDS: z.coerce.number().int().min(0).default(900),
});

/** Argon2id cost parameters (§4.1.4). */
export interface Argon2Params {
  /** Memory cost in KiB. */
  readonly memoryKib: number;
  /** Iterations (time cost). */
  readonly iterations: number;
  /** Parallelism (lanes). */
  readonly parallelism: number;
}

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
  /** Max attachment upload size in bytes (advertised + enforced). */
  readonly maxUploadBytes: number;
  /** Optional admin contact for discovery; omitted when unset. */
  readonly contact?: string;
  /** Argon2id password-hashing cost (§4.1.4); env-validated to spec minimums. */
  readonly argon2: Argon2Params;
  /** Bootstrap-token TTL in seconds (§4.2). */
  readonly bootstrapTtlSeconds: number;
  /** `cache_until` window for the public keys endpoint in seconds (§4.6). */
  readonly userKeysCacheSeconds: number;
  /** Message edit window in seconds (§5.3); basis of `permissions.editUntil`. */
  readonly messageEditWindowSeconds: number;
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
    maxUploadBytes: raw.MAX_UPLOAD_BYTES,
    argon2: Object.freeze({
      memoryKib: raw.ARGON2_MEMORY_KIB,
      iterations: raw.ARGON2_ITERATIONS,
      parallelism: raw.ARGON2_PARALLELISM,
    }),
    bootstrapTtlSeconds: raw.BOOTSTRAP_TTL_SECONDS,
    userKeysCacheSeconds: raw.USER_KEYS_CACHE_SECONDS,
    messageEditWindowSeconds: raw.MESSAGE_EDIT_WINDOW_SECONDS,
    ...(raw.CONTACT !== undefined ? { contact: raw.CONTACT } : {}),
  });
}
