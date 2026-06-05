/**
 * Drizzle table definitions (bun:sqlite dialect).
 *
 * Intentionally minimal for the P2 skeleton: only `app_meta`, a key/value
 * store used to exercise the migration path and hold provider-level metadata
 * (schema version, instance id, etc.). Domain tables (users, device_keys,
 * groups, …) are added by their respective feature cards — do NOT add them
 * here, to avoid overlap.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Provider-level key/value metadata. */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type AppMetaRow = typeof appMeta.$inferSelect;
export type NewAppMetaRow = typeof appMeta.$inferInsert;

/**
 * The provider's own Ed25519 signing identity (spec §8.1), distinct from user
 * device keys. Generated once on first boot and reused across restarts. The
 * `private_key` column is internal-only and MUST never appear in an HTTP
 * response — only the `public_key` is published in discovery (§3.1). Multiple
 * rows are allowed to support future key rotation.
 */
export const providerKeys = sqliteTable("provider_keys", {
  /** Stable identifier, e.g. `psk-<short>`. Published as `key_id`. */
  keyId: text("key_id").primaryKey(),
  /** Base64 raw 32-byte Ed25519 public key. Published in discovery. */
  publicKey: text("public_key").notNull(),
  /** Base64 raw 32-byte Ed25519 private seed. Secret; never served. */
  privateKey: text("private_key").notNull(),
  /** Always `Ed25519` in v0.1; column exists to support future algorithms. */
  algorithm: text("algorithm").notNull(),
  /** Creation time (epoch millis); rendered as RFC 3339 `created_at`. */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type NewProviderKeyRow = typeof providerKeys.$inferInsert;

/**
 * Local user accounts (spec §4.1). The canonical users table that later cards
 * (device keys, profiles, …) extend or reference via `handle`.
 *
 * `handle` is the primary key and the stable, provider-scoped identifier
 * (lowercase alnum / `_` / `-`). `password_hash` is an Argon2id PHC string
 * (§4.1.4) — verification is fully self-contained (salt + params embedded), so
 * no separate salt/params columns are needed. The hash is internal-only and
 * MUST never appear in an HTTP response.
 */
export const users = sqliteTable("users", {
  /** Provider-scoped handle, e.g. `alice`. Primary key + unique identity. */
  handle: text("handle").primaryKey(),
  /** Argon2id PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`). Secret. */
  passwordHash: text("password_hash").notNull(),
  /** Optional recovery email for account recovery (§4.1.3). */
  recoveryEmail: text("recovery_email"),
  /** Creation time (epoch millis). */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/**
 * Bootstrap tokens (spec §4.2). Short-lived, single-use bearer credentials that
 * authorize ONLY `POST /api/auth/device-keys` for the bound `handle`.
 *
 * Only a SHA-256 **hash** of the opaque token is stored (never the plaintext),
 * so a database leak cannot be replayed. The bound `handle` is captured at issue
 * time and is the sole source of truth for which account a device key binds to —
 * clients can never override it. `used_at` is nullable; a non-null value marks
 * the token consumed (single-use).
 */
export const bootstrapTokens = sqliteTable("bootstrap_tokens", {
  /** SHA-256 hash (hex) of the opaque token. Primary key (lookup by hash). */
  tokenHash: text("token_hash").primaryKey(),
  /** The handle that authenticated; the only valid binding for this token. */
  handle: text("handle").notNull(),
  /** Expiry time (epoch millis). Rejected once `now >= expires_at`. */
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  /** Issue time (epoch millis). */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
  /** Consumption time (epoch millis); null while unused. Single-use marker. */
  usedAt: integer("used_at", { mode: "number" }),
});

export type BootstrapTokenRow = typeof bootstrapTokens.$inferSelect;
export type NewBootstrapTokenRow = typeof bootstrapTokens.$inferInsert;
