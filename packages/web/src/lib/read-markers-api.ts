/**
 * Read-marker REST surface (OFSCP §7.7).
 *
 *  - {@link getReadMarkers} — `GET /api/me/read-markers`: the caller's summary,
 *    one `{ scopeId, lastReadMessageId?, unreadCount, groupId? }` per scope.
 *  - {@link setReadMarkers} — `PATCH /api/me/read-markers` with exactly
 *    `{ markers: [{ scopeId, lastReadMessageId }] }`; the provider moves markers
 *    forward only and answers with the scopes that advanced.
 *
 * Both go through the session's signing {@link OfscpClient} so the request carries
 * the §4.4 signature.
 */
import type { ReadMarker, ReadMarkerUpdate } from "@forumall/shared";
import type { OfscpClient } from "./ofscp-client.ts";

/** GET /api/me/read-markers → the caller's full unread summary. */
export async function getReadMarkers(client: OfscpClient): Promise<ReadMarker[]> {
  const res = await client.get<{ scopes: ReadMarker[] }>("/api/me/read-markers");
  return res.data.scopes ?? [];
}

/** PATCH /api/me/read-markers → advance markers; returns the scopes that advanced. */
export async function setReadMarkers(
  client: OfscpClient,
  markers: readonly ReadMarkerUpdate[],
): Promise<ReadMarker[]> {
  if (markers.length === 0) return [];
  const body = {
    markers: markers.map((m) => ({ scopeId: m.scopeId, lastReadMessageId: m.lastReadMessageId })),
  };
  const res = await client.patch<{ scopes: ReadMarker[] }>("/api/me/read-markers", body);
  return res.data.scopes ?? [];
}
