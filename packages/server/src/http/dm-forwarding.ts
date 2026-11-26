/**
 * Provider-signed forwarding (§8.1, §8.3 storage-follows-message) of DM
 * reactions, edits and deletes to the counterparty's home provider, and
 * relaying its answer.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { FederationFetch } from "../provider/federation/http.ts";
import { INLINE_RETRY, signedProviderFetch } from "../provider/federation/http.ts";

/**
 * Relay a peer's answer to a forwarded DM operation back to the caller: status,
 * body, `content-type`, and — so the caller's client can back off and re-sign
 * (§4.5 warm-up) — `Retry-After`.
 */
export async function relayPeerResponse(c: Context, res: Response): Promise<Response> {
  if (res.status === 204) return c.body(null, 204);
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "retry-after"]) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  return c.body(await res.text(), res.status as ContentfulStatusCode, headers);
}

/**
 * Forward a DM reaction add/remove to the counterparty's home provider via a
 * provider-signed request (§8.1), mirroring the DM-send delivery path: the
 * reaction targets a message stored only in the remote recipient's inbox
 * (storage-follows-message, §8.3), so the authoritative store is the peer. The
 * reacting actor travels in the JSON body (a provider-signed request has no
 * `X-OFSCP-Actor`); the peer re-validates dmId membership.
 */
export async function forwardDmReaction(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  args: {
    method: "PUT" | "DELETE";
    dmId: string;
    messageId: string;
    key: string;
    counterpartyDomain: string;
    actor: string;
  },
): Promise<Response> {
  const path = `/api/federation/dms/${args.dmId}/messages/${args.messageId}/reactions/${encodeURIComponent(args.key)}`;
  const url = `https://${args.counterpartyDomain}${path}`;
  const body = JSON.stringify({ actor: args.actor });
  return signedProviderFetch(
    db,
    config,
    {
      method: args.method,
      url,
      body,
      headers: { "content-type": "application/json" },
      // PUT/DELETE of a reaction is idempotent → safe to retry a warm-up 503.
      retry: INLINE_RETRY,
    },
    federationFetch,
  );
}

/**
 * Forward an edit of a sent DM to the counterparty's home provider (§8.1),
 * mirroring {@link forwardDmReaction}: the message lives only in the remote
 * recipient's inbox (storage-follows-message, §8.3), so the authoritative store
 * is the peer. The body is the client's whole `MessageUpdate` (every field it
 * carries: content, attachments, tags, mentions, article fields — §7.1) plus
 * the acting `actor` (a provider-signed request has no `X-OFSCP-Actor`); the
 * peer re-validates dmId membership, enforces author-only + the edit window,
 * and only then checks the edit (incl. the §5.8 attachment checks).
 */
export async function forwardDmEdit(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  args: {
    dmId: string;
    messageId: string;
    counterpartyDomain: string;
    actor: string;
    /** The `MessageUpdate` body as the client sent it (checked by the peer). */
    update: object;
  },
): Promise<Response> {
  const path = `/api/federation/dms/${args.dmId}/messages/${args.messageId}`;
  const url = `https://${args.counterpartyDomain}${path}`;
  // `actor` last: the authenticated actor, never one the client put in its body.
  const body = JSON.stringify({ ...args.update, actor: args.actor });
  return signedProviderFetch(
    db,
    config,
    {
      method: "PATCH",
      url,
      body,
      headers: { "content-type": "application/json" },
      // The edit REPLACES each field it carries (same body → same result): idempotent.
      retry: INLINE_RETRY,
    },
    federationFetch,
  );
}

/**
 * Forward a delete (tombstone) of a sent DM to the counterparty's home provider
 * (§8.1), mirroring {@link forwardDmEdit}. The acting actor travels in the body;
 * the peer enforces author-only against the stored copy.
 */
export async function forwardDmDelete(
  db: Db,
  config: Config,
  federationFetch: FederationFetch,
  args: {
    dmId: string;
    messageId: string;
    counterpartyDomain: string;
    actor: string;
  },
): Promise<Response> {
  const path = `/api/federation/dms/${args.dmId}/messages/${args.messageId}`;
  const url = `https://${args.counterpartyDomain}${path}`;
  const body = JSON.stringify({ actor: args.actor });
  return signedProviderFetch(
    db,
    config,
    {
      method: "DELETE",
      url,
      body,
      headers: { "content-type": "application/json" },
      retry: INLINE_RETRY, // tombstoning twice is a no-op: idempotent
    },
    federationFetch,
  );
}
