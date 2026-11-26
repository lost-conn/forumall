/**
 * Drizzle table definitions (bun:sqlite dialect) — the barrel every caller
 * imports. The tables live in `tables/*.ts`, one module per domain; each table's
 * DDL is created by a migration in `migrate.ts` (forward-only).
 */
export * from "./tables/identity.ts";
export * from "./tables/groups.ts";
export * from "./tables/messages.ts";
export * from "./tables/dms.ts";
export * from "./tables/social.ts";
export * from "./tables/notifications.ts";
export * from "./tables/discovery.ts";
