/**
 * Known-providers storage + scrape helper (spec §8.6, OPTIONAL).
 *
 * A provider MAY maintain a list of known peers to support discovery (§11.2)
 * without a central registry. This module owns the `known_providers` row
 * lifecycle and the row ↔ canonical `ProvidersResponse` entry mapping. How the
 * list is populated is provider-defined; here the baseline is **manual seeding**
 * ({@link addKnownProvider}) plus an optional **scrape** of a peer's own
 * `GET /api/providers` ({@link scrapeKnownProviders}) that merges what it returns.
 *
 * Whether the list is exposed at all is gated by `config.enableKnownProviders`
 * (the HTTP layer 404s when off); this module just persists/reads rows, so it is
 * usable for seeding regardless of the toggle.
 *
 * There is intentionally no feed here — §8.6 is a flat peer list, and the
 * discovery feed (§11.2) is compiled at read time elsewhere
 * (`provider/discover.ts`) and never stored.
 */
import {
  type ProvidersResponse,
  ProvidersResponseSchema,
  canonicalAuthority,
  rfc3339Timestamp,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { type KnownProviderRow, knownProviders } from "../db/schema.ts";
import { federationGet } from "./federation/http.ts";
import type { FederationFetch } from "./federation/http.ts";

/** The `GET /api/providers` path on a peer (§8.6). */
const PROVIDERS_PATH = "/api/providers";

/** A known-provider entry, the canonical `ProvidersResponse.providers[]` shape. */
export type KnownProvider = ProvidersResponse["providers"][number];

/** Map a stored row to the canonical providers-list entry (§8.6). */
export function rowToKnownProvider(row: KnownProviderRow): KnownProvider {
  return {
    domain: row.domain,
    ...(row.name != null ? { name: row.name } : {}),
    addedAt: rfc3339Timestamp(new Date(row.addedAt)),
  };
}

/** The raw row for `domain` (canonicalized), or `null` if not recorded. */
export function getKnownProviderRow(db: Db, domain: string): KnownProviderRow | null {
  const host = canonicalAuthority(domain);
  return (
    db.drizzle
      .select()
      .from(knownProviders)
      .where(eq(knownProviders.domain, host))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Record `domain` as a known peer (§8.6). Idempotent on the canonicalized
 * domain: an already-known peer is left as-is (its original `addedAt` is
 * preserved), though a previously-unset `name` is filled in when provided.
 * Returns the canonical entry plus whether a new row was inserted.
 */
export function addKnownProvider(
  db: Db,
  domain: string,
  name?: string | null,
): { provider: KnownProvider; created: boolean } {
  const host = canonicalAuthority(domain);
  const existing = getKnownProviderRow(db, host);
  if (existing) {
    // Backfill a name if we learned one and had none; otherwise leave untouched.
    if (existing.name == null && name != null && name !== "") {
      db.drizzle.update(knownProviders).set({ name }).where(eq(knownProviders.domain, host)).run();
      return { provider: rowToKnownProvider({ ...existing, name }), created: false };
    }
    return { provider: rowToKnownProvider(existing), created: false };
  }

  const row: KnownProviderRow = {
    domain: host,
    name: name != null && name !== "" ? name : null,
    addedAt: Date.now(),
  };
  db.drizzle.insert(knownProviders).values(row).run();
  return { provider: rowToKnownProvider(row), created: true };
}

/** All known peers, oldest-first (stable order for the shared list, §8.6). */
export function listKnownProviders(db: Db): KnownProvider[] {
  return db.drizzle
    .select()
    .from(knownProviders)
    .orderBy(knownProviders.addedAt)
    .all()
    .map(rowToKnownProvider);
}

/**
 * Scrape a peer's `GET /api/providers` (§8.6) and merge its entries into our
 * known-providers list. This is how a provider grows its graph from a seed peer
 * it already knows. Minimal by design:
 *
 *  - fetches `https://{domain}/api/providers` (public, unsigned) via the injected
 *    {@link FederationFetch} — the same transport the discovery cache uses, so
 *    the two-provider test harness reaches in-process peers;
 *  - validates the body against `ProvidersResponseSchema`; a non-200, non-JSON,
 *    or schema-invalid response yields zero merges (returns `[]`);
 *  - records the SCRAPED PEER itself plus every peer it lists (skipping our own
 *    domain), via {@link addKnownProvider} (idempotent).
 *
 * Returns the list of domains newly inserted by this scrape (existing peers are
 * not re-reported). Applying the §8 allow/deny policy before recording a scraped
 * peer is an allowed refinement (§8.6) and left as a documented hook.
 */
export async function scrapeKnownProviders(
  db: Db,
  config: Config,
  domain: string,
  federationFetch?: FederationFetch,
): Promise<string[]> {
  const host = canonicalAuthority(domain);
  const selfHost = canonicalAuthority(config.domain);
  const url = `https://${host}${PROVIDERS_PATH}`;

  let res: Response;
  try {
    res = await federationGet(host, url, {}, federationFetch);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return [];
  }
  const result = ProvidersResponseSchema.safeParse(parsed);
  if (!result.success) return [];

  const newlyAdded: string[] = [];
  // The seed peer itself is now known.
  const seed = canonicalAuthority(host);
  if (seed !== selfHost && addKnownProvider(db, seed).created) newlyAdded.push(seed);

  for (const entry of result.data.providers) {
    const peer = canonicalAuthority(entry.domain);
    // Skip ourselves; a peer MAY list us back, but we never record our own
    // domain as a "known provider".
    if (peer === selfHost) continue;
    // Hook: a provider MAY apply its §8 allow/deny policy here before recording a
    // scraped peer (§8.6). Left open — merge is unconditional in v0.1.
    if (addKnownProvider(db, peer, entry.name ?? null).created) newlyAdded.push(peer);
  }

  return newlyAdded;
}
