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
