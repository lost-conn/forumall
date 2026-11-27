/**
 * Fixtures shared by the read-marker suites (§7.7), on top of
 * `provider-harness.ts`: seed groups, channel messages and DM inbox messages
 * directly through the provider helpers (message creation has its own suites),
 * and call the two read-marker endpoints over the real signed HTTP surface.
 */
import { createChannel } from "../../src/provider/channels.ts";
import { storeDmMessage } from "../../src/provider/dms.ts";
import { createGroup } from "../../src/provider/groups.ts";
import { addMember } from "../../src/provider/membership.ts";
import { createMessage } from "../../src/provider/messages.ts";
import { type Booted, type Signer, signedReq } from "./provider-harness.ts";

/** A seeded message: its wire id and its provider-internal seq. */
export interface Seeded {
  readonly id: string;
  readonly seq: number;
}

/** One `ReadMarker` as the wire reports it (§7.7). */
export interface WireMarker {
  scopeId: string;
  lastReadMessageId?: string;
  unreadCount: number;
  groupId?: string;
}

/** The local handle of a signer (`alice@providera.test` → `alice`). */
export function handleOf(signer: Signer): string {
  return signer.actor.slice(0, signer.actor.indexOf("@"));
}

/**
 * A private group owned by `owner`, with `members` added as `member`, and one
 * private text channel in it.
 */
export function seedGroupChannel(
  b: Booted,
  owner: Signer,
  members: readonly Signer[] = [],
  tier: "private" | "public" = "private",
): { groupId: string; channelId: string } {
  const groupId = createGroup(b.db, owner.actor, { name: "g", tier }).id;
  for (const m of members) addMember(b.db, groupId, m.actor, "member");
  const channelId = createChannel(b.db, groupId, { type: "text", tier }).id;
  return { groupId, channelId };
}

/** Post `text` from `author` in `(groupId, channelId)`. */
export function post(
  b: Booted,
  groupId: string,
  channelId: string,
  author: Signer,
  text: string,
): Seeded {
  const r = createMessage(b.db, b.config, {
    groupId,
    channelId,
    author: author.actor,
    type: "message",
    content: { text, mime: "text/plain" },
  });
  return { id: r.message.id, seq: r.seq };
}

/** Store a DM from `author` in `owner`'s inbox under `dmId`. */
export function dmTo(b: Booted, dmId: string, owner: Signer, author: Signer, text: string): Seeded {
  const r = storeDmMessage(b.db, b.config, {
    dmId,
    owner: handleOf(owner),
    author: author.actor,
    content: { text, mime: "text/plain" },
  });
  return { id: r.message.id, seq: r.seq };
}

/** `PATCH /api/me/read-markers` with `body` as given (any shape). */
export function patchMarkers(b: Booted, signer: Signer, body: unknown): Promise<Response> {
  return signedReq(b, signer, "PATCH", "/api/me/read-markers", body);
}

/** `PATCH` the spec body `{ markers: [{ scopeId, lastReadMessageId }] }`; returns `scopes`. */
export async function markRead(
  b: Booted,
  signer: Signer,
  markers: readonly { scopeId: string; lastReadMessageId: string }[],
): Promise<WireMarker[]> {
  const res = await patchMarkers(b, signer, { markers });
  if (res.status !== 200) throw new Error(`PATCH read-markers → ${res.status}`);
  return ((await res.json()) as { scopes: WireMarker[] }).scopes;
}

/** `GET /api/me/read-markers`; returns `scopes`. */
export async function getMarkers(b: Booted, signer: Signer): Promise<WireMarker[]> {
  const res = await signedReq(b, signer, "GET", "/api/me/read-markers");
  if (res.status !== 200) throw new Error(`GET read-markers → ${res.status}`);
  return ((await res.json()) as { scopes: WireMarker[] }).scopes;
}

/** The GET entry for `scopeId`, if listed. */
export async function markerFor(
  b: Booted,
  signer: Signer,
  scopeId: string,
): Promise<WireMarker | undefined> {
  return (await getMarkers(b, signer)).find((s) => s.scopeId === scopeId);
}
