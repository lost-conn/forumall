/**
 * `/api/admin/discover` router — admin-curated discover allowlist (Forumall
 * extension, not OFSCP). All routes are `requireSignature()` + `requireAdmin()`.
 *
 *  - `GET /api/admin/discover` → `{ featured, candidates }`, both arrays of the
 *    canonical `Group` shape (via `rowToGroup`). `featured` = the groups the
 *    admin has featured; `candidates` = groups that have at least one
 *    `tier='discoverable'` channel AND are not already featured (so the admin
 *    only features groups that actually have discoverable content).
 *  - `PUT /api/admin/discover/{groupId}` → feature the group (404 if it doesn't
 *    exist). Idempotent → 200 with the featured group.
 *  - `DELETE /api/admin/discover/{groupId}` → unfeature (idempotent) → 204.
 *
 * The discover compile path (`provider/discover.ts`) intersects this allowlist
 * with the channel-level `discoverable` tier filter at read time.
 */
import type { Group } from "@forumall/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { channels, groups } from "../db/schema.ts";
import {
  featureGroup,
  listFeaturedGroupIds,
  unfeatureGroup,
} from "../provider/discover-features.ts";
import { getGroupRow, rowToGroup } from "../provider/groups.ts";
import { requireAdmin } from "./admin-guard.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

export function createAdminDiscoverRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  const admin = requireAdmin();

  /** GET /api/admin/discover — featured + candidate groups. */
  router.get("/discover", signed, admin, (c) => {
    const { db } = c.var;

    const featuredIds = listFeaturedGroupIds(db);
    const featuredSet = new Set(featuredIds);

    // Featured groups (skip any whose group row was deleted out from under us).
    const featured: Group[] = featuredIds
      .map((id) => getGroupRow(db, id))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map(rowToGroup);

    // Candidate groups: those with ≥1 discoverable-tier channel, minus the ones
    // already featured. Distinct group ids that own a discoverable channel.
    const candidateIds = db.drizzle
      .selectDistinct({ groupId: channels.groupId })
      .from(channels)
      .where(sql`${channels.tier} = 'discoverable'`)
      .all()
      .map((r) => r.groupId)
      .filter((id) => !featuredSet.has(id));

    const candidates: Group[] = candidateIds
      .map((id) => getGroupRow(db, id))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map(rowToGroup);

    return c.json({ featured, candidates });
  });

  /** PUT /api/admin/discover/{groupId} — feature a group (404 if missing). */
  router.put("/discover/:groupId", signed, admin, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    const groupId = c.req.param("groupId");
    // `actor` is set by requireSignature(); fall back to its handle for audit.
    const addedBy = actor?.handle ?? "";
    featureGroup(db, groupId, addedBy);
    const row = getGroupRow(db, groupId);
    // featureGroup already validated existence, but guard a raced delete.
    return c.json(row ? rowToGroup(row) : { featured: groupId }, 200);
  });

  /** DELETE /api/admin/discover/{groupId} — unfeature a group (idempotent). */
  router.delete("/discover/:groupId", signed, admin, (c) => {
    const { db } = c.var;
    const groupId = c.req.param("groupId");
    unfeatureGroup(db, groupId);
    return c.body(null, 204);
  });

  return router;
}
