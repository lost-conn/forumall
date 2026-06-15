/**
 * Provider admin — the "who runs this instance" identity layer (Forumall
 * extension, not part of OFSCP).
 *
 * An admin is the operator of this self-hosted provider. There is no admin
 * registration flow: the **first** account to register on a fresh instance is
 * the implicit owner (`users.is_admin = 1`), and any handle listed in
 * `config.adminHandles` is treated as admin regardless of registration order
 * (and even if the persisted flag was never set — e.g. the handle was added to
 * the env after the account already existed).
 *
 * This module is small and pure: `isProviderAdmin` answers the authorization
 * question, `countUsers` backs the first-user bootstrap in the register handler.
 * The HTTP guard that consumes this is `requireAdmin` in `http/admin-guard.ts`.
 */
import { eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { users } from "../db/schema.ts";

/**
 * Whether `handle` is a provider admin: true iff the user row's `is_admin` flag
 * is set OR the (lowercased) handle is listed in `config.adminHandles`. The
 * env-list check is intentionally independent of the persisted flag so an
 * operator can grant admin by editing `ADMIN_HANDLES` without a data migration.
 */
export function isProviderAdmin(db: Db, config: Config, handle: string): boolean {
  if (config.adminHandles.includes(handle.toLowerCase())) return true;
  const row = db.drizzle
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1)
    .all()[0];
  return row?.isAdmin === true;
}

/** Total number of registered user accounts (backs the first-user bootstrap). */
export function countUsers(db: Db): number {
  const row = db.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get();
  return row?.n ?? 0;
}
