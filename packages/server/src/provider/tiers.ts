/**
 * Canonical tier catalogue + shared tier-visibility rule (spec §11 Tiers,
 * §5.5 Group & Channel Endpoints).
 *
 * A tier is the access/discoverability level of a group or channel. The four
 * v0.1 tiers are advertised in discovery under `capabilities.tiers` (§3.1) and
 * listed with human descriptions at `GET /api/tiers` (§11.1).
 *
 * `PUBLIC_TIERS` and the tier+membership readability decision below were
 * previously redefined in four places (`provider/channels.ts`,
 * `http/channels.ts`, `http/groups.ts`, `http/membership.ts`) — they agreed by
 * luck, not by construction, which is a drift risk (Forumall/OFSCP
 * spec-reconciliation report, #19/#24 addendum). This is the one definition;
 * every caller deciding "is this `public`/`discoverable`/`private`/`group`-tier
 * object readable by this actor?" goes through {@link isPublicTier} or
 * {@link tierReadableBy}.
 *
 * This module intentionally knows nothing about the per-channel `permissions`
 * `view` override (§5.2.1) — that is layered on top by
 * `provider/channels.ts`'s `canViewChannel`, the actual single decision point
 * for "may this actor read this CHANNEL". This module only answers the
 * tier+membership question, which is also all a GROUP's own visibility needs.
 */
import type { TiersResponse } from "@forumall/shared";

import type { Db } from "../db/index.ts";
import { isMember } from "./permissions.ts";

/** Tier ids advertised in `capabilities.tiers`, in canonical order. */
export const TIER_IDS = ["private", "group", "public", "discoverable"] as const;
export type TierId = (typeof TIER_IDS)[number];

/** The canonical `GET /api/tiers` payload (§11.1). MUST include `private`. */
export const TIERS: TiersResponse = {
  tiers: [
    {
      id: "private",
      name: "Private",
      description: "Only invited members can see this channel.",
    },
    {
      id: "group",
      name: "Group",
      description: "Visible to members of the owning group.",
    },
    {
      id: "public",
      name: "Public",
      description: "Visible to anyone with the link.",
    },
    {
      id: "discoverable",
      name: "Discoverable",
      description: "Public and eligible to appear in discovery feeds across federated providers.",
    },
  ],
};

/** Tiers that are readable without group membership (§11, §5.5). */
export const PUBLIC_TIERS: ReadonlySet<string> = new Set(["public", "discoverable"]);

/** Whether `tier` alone grants read access to anyone, without membership. */
export function isPublicTier(tier: string): boolean {
  return PUBLIC_TIERS.has(tier);
}

/**
 * Whether an object (a group, or considered in isolation, a channel) of `tier`
 * that lives in `groupId` is readable by `actor` on tier + membership grounds
 * alone: a `public`/`discoverable` tier is readable by anyone; a
 * `private`/`group` tier only by an authenticated member of `groupId`.
 *
 * Used directly for GROUP visibility (`groupId` and `tier` both the group's
 * own). For CHANNEL visibility, `provider/channels.ts`'s `channelVisibleTo`
 * calls this twice — once for the channel's group, once for the channel
 * itself — and requires both, so a channel tier can never widen its group's
 * access (§11; see that function's doc comment).
 */
export function tierReadableBy(
  db: Db,
  groupId: string,
  tier: string,
  actor: string | null | undefined,
): boolean {
  if (isPublicTier(tier)) return true;
  return actor != null && isMember(db, groupId, actor);
}
