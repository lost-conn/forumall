/**
 * Read-marker REST surface (read/unread tracking — a provider-local extension).
 *
 *  - {@link getReadMarkers} — GET the caller's unread summary (one entry per
 *    visible channel + DM scope).
 *  - {@link setReadMarkers} — PATCH one or many markers forward; the server
 *    persists monotonically and fans a `read.updated` event to the caller's other
 *    devices. Returns the touched markers with recomputed unread counts.
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

/** PATCH /api/me/read-markers → advance markers; returns the touched entries. */
export async function setReadMarkers(
  client: OfscpClient,
  markers: ReadMarkerUpdate[],
): Promise<ReadMarker[]> {
  if (markers.length === 0) return [];
  const res = await client.patch<{ scopes: ReadMarker[] }>("/api/me/read-markers", { markers });
  return res.data.scopes ?? [];
}
