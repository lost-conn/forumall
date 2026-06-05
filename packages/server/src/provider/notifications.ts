/**
 * Notification webhook endpoints + provider-signed delivery (spec §10).
 *
 * Two concerns live here:
 *
 *  1. **Registration store** — {@link registerEndpoint} / {@link listEndpoints} /
 *     {@link getEndpoint} / {@link deleteEndpoint} own the `notification_endpoints`
 *     row lifecycle and the row ↔ canonical `NotificationsWebhookRegistration`
 *     mapping. An endpoint binds a LOCAL `owner` (handle) to a `target` URL and a
 *     set of subscribed event names.
 *
 *  2. **Delivery** — {@link deliverNotification} fans an event out to every
 *     matching endpoint: it builds the canonical delivery payload, computes the
 *     detached Ed25519 signature, and POSTs the payload **provider-signed** (§8.1)
 *     to each `target` via the injected {@link FederationFetch}.
 *
 * ## Canonical delivery payload (§10) — deterministic serialization
 * The body POSTed to a `target` is a `NotificationsDelivery`:
 *   `{ event, resource, provider, signature }`
 * The **detached `signature`** is an Ed25519 signature (base64) over the
 * **canonical payload** — the delivery object WITHOUT the `signature` field
 * (`{ event, resource, provider }`) serialized deterministically by
 * {@link canonicalDeliveryPayload}: a single JSON object with keys emitted in a
 * fixed, recursively key-sorted order (so the receiver can recompute the exact
 * bytes and `verifyDetached` against this provider's published signing key,
 * `provider.publicKeys`, §3.1). The serialization is `JSON.stringify` over a
 * value whose object keys are sorted ascending at every level, with no
 * insignificant whitespace — i.e. canonical JSON. `resource` keeps whatever
 * fields the caller supplied (always `id`, usually `channel`), sorted the same
 * way.
 *
 * ## Why both signatures (§8.1 + §10)
 * The HTTP request is provider-signed so the receiver authenticates the SENDER at
 * the transport layer (the `X-OFSCP-*` headers). The detached body `signature`
 * lets a stored copy of the payload stay verifiable AFTER transport — a receiver
 * that persists the webhook can re-verify it later without the original HTTP
 * headers.
 */
import { type NotificationsWebhookRegistration, signDetached } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { type NotificationEndpointRow, groupMembers, notificationEndpoints } from "../db/schema.ts";
import { type FederationFetch, signedProviderFetch } from "./federation/http.ts";
import { getProviderSigningKey } from "./signing-key.ts";

/** `nep_` id prefix + entropy for a registered endpoint. */
const ENDPOINT_ID_PREFIX = "nep_";
const ENDPOINT_ID_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Mint a provider-generated endpoint id (`nep_<base64url>`). */
function mintEndpointId(): string {
  const raw = new Uint8Array(ENDPOINT_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${ENDPOINT_ID_PREFIX}${toBase64Url(raw)}`;
}

/** A registered endpoint as returned to the owner (echo of the registration + id). */
export interface RegisteredEndpoint extends NotificationsWebhookRegistration {
  /** Stable endpoint id (`nep_…`). */
  readonly id: string;
  /** RFC 3339 creation time. */
  readonly createdAt: string;
}

/** Map a stored row to the owner-facing registration echo (id + fields). */
function rowToEndpoint(row: NotificationEndpointRow): RegisteredEndpoint {
  const events = JSON.parse(row.events) as string[];
  return {
    id: row.id,
    type: row.type,
    target: row.target,
    events,
    createdAt: `${new Date(row.createdAt).toISOString().slice(0, 19)}Z`,
  };
}

/**
 * Register a webhook endpoint for `owner` (§10). The registration is validated
 * against the shared schema by the HTTP layer; this stores the row and returns
 * the id-stamped echo. Registration is not deduped — a user MAY register several
 * endpoints (e.g. different targets/event sets).
 */
export function registerEndpoint(
  db: Db,
  owner: string,
  reg: NotificationsWebhookRegistration,
): RegisteredEndpoint {
  const row: NotificationEndpointRow = {
    id: mintEndpointId(),
    owner,
    type: reg.type,
    target: reg.target,
    events: JSON.stringify(reg.events),
    createdAt: Date.now(),
  };
  db.drizzle.insert(notificationEndpoints).values(row).run();
  return rowToEndpoint(row);
}

/** All endpoints registered by `owner`, oldest-first. */
export function listEndpoints(db: Db, owner: string): RegisteredEndpoint[] {
  return db.drizzle
    .select()
    .from(notificationEndpoints)
    .where(eq(notificationEndpoints.owner, owner))
    .orderBy(notificationEndpoints.createdAt)
    .all()
    .map(rowToEndpoint);
}

/** A single endpoint by id (any owner), or `null`. */
export function getEndpoint(db: Db, id: string): NotificationEndpointRow | null {
  return (
    db.drizzle
      .select()
      .from(notificationEndpoints)
      .where(eq(notificationEndpoints.id, id))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Delete `owner`'s endpoint `id`. Returns true iff a row owned by `owner` was
 * removed (a non-existent id or another owner's id removes nothing).
 */
export function deleteEndpoint(db: Db, owner: string, id: string): boolean {
  const existing = getEndpoint(db, id);
  if (!existing || existing.owner !== owner) return false;
  db.drizzle
    .delete(notificationEndpoints)
    .where(and(eq(notificationEndpoints.id, id), eq(notificationEndpoints.owner, owner)))
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// Delivery (§10)
// ---------------------------------------------------------------------------

/** The resource a notification event references (`{ id, channel?, ... }`, §10). */
export interface NotificationResource {
  readonly id: string;
  readonly channel?: string;
  readonly [k: string]: unknown;
}

/**
 * Recursively sort object keys so an equivalent value always serializes to the
 * SAME bytes (arrays keep order; primitives pass through). The basis of the
 * canonical payload's determinism.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The exact byte string the detached `signature` is computed over (§10): the
 * delivery object **without** the `signature` field — `{ event, resource,
 * provider }` — as canonical JSON (recursively key-sorted, no insignificant
 * whitespace). Exported so a receiver (and the tests) can recompute it and
 * `verifyDetached` against `provider.publicKeys`.
 */
export function canonicalDeliveryPayload(input: {
  event: string;
  resource: NotificationResource;
  provider: string;
}): string {
  return JSON.stringify(
    sortKeysDeep({
      event: input.event,
      provider: input.provider,
      resource: input.resource,
    }),
  );
}

/** A single matching event to deliver. */
export interface NotificationEvent {
  /** Event name, e.g. `message.created` / `call.started`. */
  readonly event: string;
  /** The resource the event is about (`{ id, channel?, ... }`). */
  readonly resource: NotificationResource;
  /**
   * Restrict delivery to endpoints whose owner is in this set (canonical
   * `handle@domain` actors OR bare local handles — both forms are matched). Used
   * to scope `message.created` to members of the message's group. Omit to
   * deliver to every endpoint subscribed to the event.
   */
  readonly ownerFilter?: ReadonlySet<string>;
}

/** Outcome of one delivery attempt (for fire-and-forget logging). */
export interface DeliveryResult {
  readonly endpointId: string;
  readonly target: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
}

/**
 * Deliver a matching event to every subscribed endpoint (§10).
 *
 * Selection: every endpoint whose `events` array contains `event` AND (when
 * `ownerFilter` is given) whose `owner` is in the filter. For each match: build
 * the canonical payload, compute the detached signature with this provider's
 * signing key, and POST the `{ event, resource, provider, signature }` body
 * **provider-signed** (§8.1) to the endpoint's `target` via `federationFetch`.
 *
 * Delivery is best-effort and isolated: one failing target never blocks the rest
 * (each attempt is independently caught), and the function resolves with a
 * per-endpoint {@link DeliveryResult} list. Callers that want non-blocking
 * fan-out (the WS message path) invoke this WITHOUT awaiting and log on the
 * returned promise. A zero-match event resolves to an empty list (no requests).
 */
export async function deliverNotification(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  ev: NotificationEvent,
): Promise<DeliveryResult[]> {
  // Candidate endpoints subscribed to this event. (Event membership is a JSON
  // array, so we filter in JS after the row read; the set is small per provider.)
  const rows = db.drizzle.select().from(notificationEndpoints).all();
  const matches = rows.filter((row) => {
    let events: string[];
    try {
      events = JSON.parse(row.events) as string[];
    } catch {
      return false;
    }
    if (!events.includes(ev.event)) return false;
    if (ev.ownerFilter && !ownerMatches(ev.ownerFilter, row.owner, config.domain)) return false;
    return true;
  });
  if (matches.length === 0) return [];

  const provider = config.domain;
  const key = getProviderSigningKey(db);
  const canonical = canonicalDeliveryPayload({
    event: ev.event,
    resource: ev.resource,
    provider,
  });
  const signature = signDetached(key.privateKey, canonical);

  // The wire body: the canonical payload + the detached signature. We build it
  // from the SAME key-sorted base so `{ event, resource, provider }` bytes inside
  // it are identical to `canonical` (the signature still covers only the base).
  const body = JSON.stringify({
    ...(JSON.parse(canonical) as Record<string, unknown>),
    signature,
  });

  // Fire each delivery independently; isolate failures so one bad target can't
  // abort the others.
  return Promise.all(matches.map((row) => deliverOne(db, config, federationFetch, row, body)));
}

/** POST one provider-signed delivery to an endpoint's target, catching failures. */
async function deliverOne(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  row: NotificationEndpointRow,
  body: string,
): Promise<DeliveryResult> {
  try {
    const res = await signedProviderFetch(
      db,
      config,
      {
        method: "POST",
        url: row.target,
        body,
        headers: { "content-type": "application/json" },
      },
      federationFetch,
    );
    return { endpointId: row.id, target: row.target, ok: res.ok, status: res.status };
  } catch (err) {
    return {
      endpointId: row.id,
      target: row.target,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The set of member actors (`handle@domain`) of `groupId` — the §10 fan-out
 * scope for `message.created` (only users who belong to the message's group get
 * notified). Optionally `exclude` an actor (e.g. the author, so they aren't
 * notified of their own message). Returned as a Set for `ownerFilter`.
 */
export function groupMemberActors(db: Db, groupId: string, exclude?: string): Set<string> {
  const rows = db.drizzle
    .select({ user: groupMembers.user })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
    .all();
  const out = new Set<string>();
  for (const { user } of rows) {
    if (user !== exclude) out.add(user);
  }
  return out;
}

/**
 * Whether an endpoint `owner` (stored as a bare local handle) is in the owner
 * filter. The filter holds group-member actors (`handle@domain`); we match an
 * endpoint owner against both its bare-handle form and its canonical
 * `handle@domain` form so callers can populate the filter with either.
 */
function ownerMatches(filter: ReadonlySet<string>, owner: string, domain: string): boolean {
  if (filter.has(owner)) return true;
  // Endpoint owners are local handles; also try the canonical actor form.
  return filter.has(`${owner}@${domain}`);
}
