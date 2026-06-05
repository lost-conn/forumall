/**
 * Canonical tier catalogue (spec §11).
 *
 * A tier is the access/discoverability level of a group or channel. The four
 * v0.1 tiers are advertised in discovery under `capabilities.tiers` (§3.1) and
 * listed with human descriptions at `GET /api/tiers` (§11.1).
 */
import type { TiersResponse } from "@forumall/shared";

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
