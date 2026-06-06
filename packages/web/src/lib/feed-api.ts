/**
 * Follows + discovery REST surface (P8 home feed / browse, spec §7.6 + §11.2).
 *
 * A follow is a **pointer**, not a compiled feed: the server stores only *which*
 * channels the caller follows. The home feed is composed CLIENT-SIDE by reading
 * each followed channel from its source (see `components/feed/feed-controller.ts`).
 * These wrappers are the thin REST layer:
 *
 *  - `GET /api/me/follows`         → the caller's follow pointers (§7.6),
 *  - `POST /api/me/follows`        → start following `{ channel, groupId }` (§7.6),
 *  - `DELETE /api/me/follows/{ref}`→ stop following (idempotent 204, §7.6),
 *  - `GET /api/discover`           → paged discoverable channel pointers (§11.2),
 *    which **404s** when the provider has the feature disabled — surfaced as a
 *    typed "not offered" result rather than thrown, so the UI can show a graceful
 *    state.
 *
 * Everything goes through the session's signing {@link OfscpClient} (follows are
 * signed; discover is a public read but still goes through the same client).
 */
import type { DiscoverItem, DiscoverResponse, Follow, FollowsResponse } from "@forumall/shared";
import type { OfscpClient } from "./ofscp-client.ts";

/** List the caller's follow pointers (§7.6). */
export async function fetchFollows(client: OfscpClient): Promise<Follow[]> {
  const res = await client.get<FollowsResponse>("/api/me/follows");
  return res.data.follows ?? [];
}

/**
 * Start following a channel (§7.6). `channel` is a channel ref (a bare `chn_…`
 * id for a local channel, or a URI). Idempotent server-side: an already-followed
 * channel returns 200, a new follow 201 — both yield the `Follow` pointer.
 */
export async function addFollow(
  client: OfscpClient,
  body: { channel: string; groupId?: string },
): Promise<Follow> {
  const res = await client.post<Follow>("/api/me/follows", {
    channel: body.channel,
    ...(body.groupId ? { groupId: body.groupId } : {}),
  });
  return res.data;
}

/**
 * Stop following a channel (§7.6). The server takes the channel ref as a single
 * path segment, so it is URL-encoded here (a bare `chn_…` id stays intact; a URI
 * is percent-encoded). Idempotent: always resolves (204 whether or not a row
 * existed).
 */
export async function removeFollow(client: OfscpClient, channelRef: string): Promise<void> {
  await client.delete(`/api/me/follows/${encodeURIComponent(channelRef)}`);
}

/** A discover-feed read result: the live feed, or a typed "feature off" signal. */
export type DiscoverResult =
  | { kind: "feed"; items: DiscoverItem[]; nextCursor: string | null }
  | { kind: "not-offered" };

/**
 * Read one page of the discovery feed (§11.2). When the provider has the feature
 * disabled the endpoint **404s** — caught here and returned as `not-offered` so
 * the UI shows a graceful "discovery not offered by this provider" state instead
 * of an error. `cursor` is the opaque `nextCursor` from a prior page.
 */
export async function fetchDiscover(
  client: OfscpClient,
  opts: { cursor?: string; limit?: number } = {},
): Promise<DiscoverResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  try {
    const res = await client.get<DiscoverResponse>(`/api/discover${qs ? `?${qs}` : ""}`);
    return {
      kind: "feed",
      items: res.data.items ?? [],
      nextCursor: res.data.page?.nextCursor ?? null,
    };
  } catch (err) {
    // 404 → the provider does not offer a discovery feed (feature disabled).
    if (
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status: number }).status === 404
    ) {
      return { kind: "not-offered" };
    }
    throw err;
  }
}

/**
 * Resolve a channel ref to its local channel id, or `null` when it is a foreign
 * (remote) URI. Mirrors the server's §2.4 classification: a bare `chn_…` id, or a
 * URI whose host is `homeHost`, is local; a URI with a foreign host is remote.
 */
export function localChannelId(ref: string, homeHost: string): string | null {
  if (ref.startsWith("https://") || ref.startsWith("http://")) {
    try {
      const url = new URL(ref);
      if (canonHost(url.host) !== canonHost(homeHost)) return null; // remote
      const m = url.pathname.match(/\/channels\/([^/]+)\/?$/);
      return m ? decodeURIComponent(m[1] as string) : null;
    } catch {
      return null;
    }
  }
  return ref; // bare local id
}

/**
 * The provider host a channel ref lives on: the URI host for an absolute ref, or
 * `homeHost` for a bare local id. Used to pick the WS source (the per-host
 * registry supports remote sources for a future federation run).
 */
export function hostForRef(ref: string, homeHost: string): string {
  if (ref.startsWith("https://") || ref.startsWith("http://")) {
    try {
      return new URL(ref).host;
    } catch {
      return homeHost;
    }
  }
  return homeHost;
}

/** Normalize a host for comparison (lowercase, strip a default `:443`/`:80`). */
function canonHost(host: string): string {
  return host.toLowerCase().replace(/:(443|80)$/, "");
}
