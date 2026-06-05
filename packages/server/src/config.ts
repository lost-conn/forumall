/**
 * Env-driven server configuration.
 *
 * Self-host requirement: the provider MUST boot with **no env vars set**. Every
 * value has a sensible default, so `bun run src/index.ts` works out of the box
 * and writes its state under `./data`. All values are parsed/validated with Zod
 * and exposed as a typed, immutable {@link Config}.
 */
import { join } from "node:path";
import { canonicalAuthority } from "@forumall/shared";
import { z } from "zod";

/** Coerce a possibly-undefined env string into a positive int port. */
const PortSchema = z.coerce.number().int().min(1).max(65535);

/**
 * Parse a feature-flag env var into a boolean. Accepts the usual truthy/falsy
 * spellings; an unset/empty value is left `undefined` so the schema `.default()`
 * applies (default OFF). Anything unrecognized is rejected at boot.
 */
const BoolEnvSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .union([z.boolean(), z.enum(["true", "1", "yes", "on", "false", "0", "no", "off"])])
    .transform((v) => v === true || v === "true" || v === "1" || v === "yes" || v === "on")
    .optional(),
);

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

  /**
   * Max number of post-cursor messages the WS resume path will replay per
   * channel on `subscribe` with a `since` cursor (§7.1 "Resuming after a
   * disconnect"). If the gap exceeds this cap the channel is reported in the
   * `subscribed` ack's `truncated` array and the client falls back to REST
   * history (§7.2). Default 500; configurable so tests can exercise truncation
   * with a tiny cap.
   */
  MAX_RESUME_REPLAY: z.coerce.number().int().min(0).default(500),

  /**
   * Typing-indicator auto-expiry window in ms (§7.1 "Typing indicators"). A
   * `typing.start` auto-expires into a `stop` after this long without a
   * refreshing `typing.start`. Spec RECOMMENDED ~6s; default 6000. Configurable
   * so tests can use a tiny value to exercise expiry quickly.
   */
  TYPING_TIMEOUT_MS: z.coerce.number().int().min(1).default(6000),

  /**
   * Federation allow-list (§8 Authorization): comma-separated remote provider
   * domains permitted to federate. **Empty by default → open** (every non-denied
   * domain is allowed). When non-empty, ONLY the listed domains may federate.
   * Domains are matched case-insensitively after default-port stripping.
   */
  FEDERATION_ALLOW: z.string().default(""),

  /**
   * Federation deny-list (§8 Authorization): comma-separated remote provider
   * domains blocked from federating. **Empty by default → none denied.** Deny
   * wins over the allow-list (a domain on both is denied). Disallowed peers get a
   * `403` before any remote key fetch happens.
   */
  FEDERATION_DENY: z.string().default(""),

  /**
   * Known-providers feature toggle (§8.6, OPTIONAL/MAY). When `false` (default)
   * this provider maintains no shareable peer list: `GET /api/providers` returns
   * **404** and discovery advertises `capabilities.discovery.sharesKnownProviders:
   * false`. When `true`, the provider both maintains AND shares the list (v0.1
   * collapses "maintains" and "shares" into one flag), so `GET /api/providers`
   * serves it and discovery advertises `sharesKnownProviders: true`.
   */
  ENABLE_KNOWN_PROVIDERS: BoolEnvSchema.default(false),

  /**
   * Discovery-feed feature toggle (§11.2, OPTIONAL/MAY). When `false` (default)
   * `GET /api/discover` returns **404** and discovery advertises
   * `capabilities.discovery.discoverFeed: false`. When `true`, the provider
   * compiles a read-time feed of pointers to LOCAL `discoverable`-tier channels
   * (no feed is ever stored) and advertises `discoverFeed: true`.
   */
  ENABLE_DISCOVER_FEED: BoolEnvSchema.default(false),
});

/** Parse a comma-separated domain list into canonicalized, de-duplicated hosts. */
function parseDomainList(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) seen.add(canonicalAuthority(trimmed));
  }
  return Object.freeze([...seen]);
}

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
  /** Max post-cursor messages the WS resume path replays per channel (§7.1). */
  readonly maxResumeReplay: number;
  /** Typing-indicator auto-expiry window in ms (§7.1 "Typing indicators"). */
  readonly typingTimeoutMs: number;
  /**
   * Federation allow-list (§8): canonicalized domains permitted to federate.
   * Empty → open (all non-denied domains allowed). See {@link isProviderAllowed}.
   */
  readonly federationAllow: readonly string[];
  /**
   * Federation deny-list (§8): canonicalized domains blocked from federating.
   * Deny wins over the allow-list. Empty → none denied.
   */
  readonly federationDeny: readonly string[];
  /**
   * Known-providers feature toggle (§8.6). When false (default) `GET
   * /api/providers` 404s and discovery advertises `sharesKnownProviders: false`.
   */
  readonly enableKnownProviders: boolean;
  /**
   * Discovery-feed feature toggle (§11.2). When false (default) `GET
   * /api/discover` 404s and discovery advertises `discoverFeed: false`.
   */
  readonly enableDiscoverFeed: boolean;
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
    maxResumeReplay: raw.MAX_RESUME_REPLAY,
    typingTimeoutMs: raw.TYPING_TIMEOUT_MS,
    federationAllow: parseDomainList(raw.FEDERATION_ALLOW),
    federationDeny: parseDomainList(raw.FEDERATION_DENY),
    enableKnownProviders: raw.ENABLE_KNOWN_PROVIDERS,
    enableDiscoverFeed: raw.ENABLE_DISCOVER_FEED,
    ...(raw.CONTACT !== undefined ? { contact: raw.CONTACT } : {}),
  });
}
