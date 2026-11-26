/**
 * Migration types shared by `migrate.ts` and the per-domain lists in
 * `migrations/*.ts`.
 */
import type { Database } from "bun:sqlite";

/** Provider facts a data migration may need (see `migrate` in `migrate.ts`). */
export interface MigrationContext {
  /**
   * This provider's canonical authority (`canonicalAuthority(config.domain)`):
   * a local handle `h` is the actor `h@domain`. Boot passes it ONLY when the
   * operator configured DOMAIN — the localhost fallback is not trusted to be the
   * authority the stored data was written under.
   */
  readonly domain?: string;
  /** Progress lines from data migrations (default `console.log`). */
  readonly log?: (line: string) => void;
  /**
   * Called when a migration DEFERS itself (default `console.warn`): it rolled
   * back, is not ledgered, and is retried on the next `migrate`.
   */
  readonly onDeferred?: (id: string, reason: string) => void;
}

/**
 * Thrown by a DATA migration that cannot run safely yet (e.g. it needs the
 * provider domain). `runMigrations` rolls it back, leaves it unledgered
 * so the next boot retries it, and reports it via `onDeferred`; it continues
 * past an `independent` migration and stops at any other.
 */
export class MigrationDeferred extends Error {}

/** One forward-only schema (or data) migration. */
export interface Migration {
  /** Stable, unique identifier; ledgered once applied. Never reuse/rename. */
  readonly id: string;
  /** Idempotent-friendly DDL. Runs inside a transaction. */
  readonly up: (sqlite: Database, ctx: MigrationContext) => void;
  /**
   * A data-only migration that no later migration depends on. Only such a
   * migration may be SKIPPED when it defers: the runner continues past it (and
   * retries it next boot). A deferred migration without this flag stops the run.
   */
  readonly independent?: boolean;
}
