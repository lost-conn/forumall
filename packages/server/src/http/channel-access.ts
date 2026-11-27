/**
 * The §11.3 read gate for requests that name a channel, in the two shapes the
 * HTTP and WS layers need. Both wrap {@link getReadableChannel}, which answers
 * `null` alike for a channel that does not exist, lives in another group, or
 * cannot be read by the actor — so "hidden channels answer as missing" (§11.3)
 * holds by construction on every surface that uses them:
 *
 *  - {@link requireReadableChannel} — REST routes: throws the `404` problem.
 *  - {@link CHANNEL_NOT_FOUND} — the structured error the shared message
 *    mutation helpers (`message-mutations.ts`) and WS commands answer with
 *    (`not_found` over WS, `404` over REST).
 *
 * A `403` is only ever decided after this gate, for an actor who can read the
 * channel but lacks a permission (`post:<type>`, `react`, `manage`, …).
 *
 * The channel-join alias (`POST …/channels/{id}/join`, §8.2) deliberately does
 * not use this gate: it answers as a group join.
 */
import type { Db } from "../db/index.ts";
import type { ChannelRow } from "../db/schema.ts";
import { getReadableChannel } from "../provider/channels.ts";
import { getGroupRow } from "../provider/groups.ts";
import { AppError } from "./errors.ts";
import type { MutationError } from "./message-mutations.ts";

/** The answer for a channel that is missing or that the actor cannot read. */
export const CHANNEL_NOT_FOUND: MutationError = { code: "not_found", message: "no such channel" };

/**
 * Resolve `channelId` in `groupId` for a REST request by `actor` (`null` for an
 * anonymous viewer, §4.5). An unknown group is `404` "no such group"; a channel
 * that is missing, in another group, or unreadable is the same `404` "no such
 * channel".
 */
export function requireReadableChannel(
  db: Db,
  groupId: string,
  channelId: string,
  actor: string | null,
): ChannelRow {
  if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
  const row = getReadableChannel(db, channelId, actor, groupId);
  if (!row) throw AppError.notFound({ detail: CHANNEL_NOT_FOUND.message });
  return row;
}
