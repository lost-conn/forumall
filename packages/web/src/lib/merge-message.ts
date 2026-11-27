/**
 * Merging a newer (or older) copy of a message into the stored one, IN PLACE,
 * shared by the chat and DM stores so their rules cannot drift.
 *
 * Copies arrive out of order: a history page fetched before a live edit or
 * delete can land after it (`loadOlder`, `loadReplies`, a resume backfill). So
 * a merge first decides which copy is the newer VERSION of the message
 * ({@link isOlderCopy}):
 *
 * - An UNSETTLED local mutation ({@link LocalVersion.unsettled}) ranks above
 *   every server copy, a tombstone included: while its request (or an earlier
 *   mutation's, queued ahead of it) is unanswered, any server copy that arrives
 *   is an earlier edit's or this mutation's own confirmation, and the mutation's
 *   settle installs the outcome itself (`components/dms/dm-mutation-chain.ts`).
 *   A new unsettled copy outranks whatever is stored: it is the user's latest
 *   intent.
 * - A tombstone is terminal. A stored copy with `deletedAt` is newer than any
 *   copy without it, so no merge un-deletes a message; an incoming copy with
 *   `deletedAt` is newer than a live stored one.
 * - Otherwise edit recency decides, on the holding provider's clock only. A
 *   server copy's version is its `editedAt`: a later one is newer, and a copy
 *   with no `editedAt` is older than one that has it.
 * - An optimistic local edit ({@link LocalVersion}) is never ordered by the
 *   client's clock, which may run fast or slow (its `editedAt` is display
 *   only). It ranks just above the server version it was made from
 *   (`basedOn`): above that copy and anything older (a stale history page),
 *   below any later server copy — the confirmation of the edit, or a later
 *   edit — which then replaces it. Two local edits on the same base: the
 *   incoming one (the user's latest) wins.
 * - Equal versions (both unedited, the same `editedAt`, or local edits on the
 *   same base) take the incoming copy.
 *
 * `versionKeys` names the fields a version owns (`content`, `attachments`, an
 * article's `title`/`cover`, a reply `reference`, `editedAt`…). When the
 * incoming copy is the same version or newer, the stored object mirrors it for
 * those fields: each one the copy lacks (key omitted, or present with the value
 * `undefined`, as some mappings write it) is removed, so an edit that REMOVES an
 * optional field clears it. `localVersion` is always a version field, so a
 * server copy that wins over a local edit clears the marker. When the incoming
 * copy is older, every version field (and `editedAt`/`deletedAt`/
 * `localVersion`) is left as stored. Every other key is local
 * or listing metadata (a timeline `cursor`, the optimistic-echo
 * `clientMessageId` / `pending` / `failed`, a DM's `mine`, the advisory
 * `replyCount`): it is taken from any copy, old or new, but only as a defined
 * value, so a copy without a `cursor` (a duplicate-create answer) keeps the
 * stored one. No key is ever left holding `undefined`, and `deletedAt` is never
 * removed by a merge.
 *
 * Merging in place, not replacing the object, keeps the stored object's
 * identity, which `<For>` keys a rendered row on (an open lightbox or an edit in
 * progress survives the update). Inside a Solid `produce` the deletes and
 * assignments go through the store proxy, so they are reactive.
 */

/**
 * Marks a copy as an optimistic local edit the server has not yet confirmed.
 * `basedOn` is the `editedAt` of the server version the edit was made from,
 * absent when that version was unedited. Only the DM store makes local edits
 * (a channel edit waits for the server's `message.updated`).
 */
export interface LocalVersion {
  basedOn?: string;
  /**
   * Set (in memory only, never persisted) while the mutation that made this
   * copy, or an earlier mutation of the message queued ahead of it, is still
   * unanswered in this page. Such a copy outranks every server copy; when the
   * last unsettled mutation is answered the marker is dropped and the outcome
   * installed.
   */
  unsettled?: true;
}

/** The fields that order two copies of one message (see {@link isOlderCopy}). */
export interface MessageVersion {
  editedAt?: string;
  deletedAt?: string;
  localVersion?: LocalVersion;
}

/**
 * The {@link LocalVersion} for a new local edit of `current`: based on the
 * server version `current` is, or, when `current` is itself an unconfirmed
 * local edit, on the server version that one was based on.
 */
export function localVersionOf(current: MessageVersion): LocalVersion {
  const basedOn = current.localVersion ? current.localVersion.basedOn : current.editedAt;
  return basedOn !== undefined ? { basedOn } : {};
}

/**
 * Compare two RFC 3339 timestamps: negative when `a` is earlier. Parsed as
 * instants so differing offsets compare correctly; an unparseable value falls
 * back to a string comparison.
 */
function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? -1 : a > b ? 1 : 0;
  return ta - tb;
}

/**
 * Order two live copies by version: negative when `a` is older. The server
 * stamp is `editedAt`, or a local edit's `basedOn`; no stamp (unedited) is the
 * oldest. On equal stamps a local edit ranks above the server copy it was based
 * on.
 */
function compareVersions(a: MessageVersion, b: MessageVersion): number {
  const stampA = a.localVersion ? a.localVersion.basedOn : a.editedAt;
  const stampB = b.localVersion ? b.localVersion.basedOn : b.editedAt;
  if (stampA !== stampB) {
    if (stampA === undefined) return -1;
    if (stampB === undefined) return 1;
    const byStamp = compareTimestamps(stampA, stampB);
    if (byStamp !== 0) return byStamp;
  }
  return Number(a.localVersion !== undefined) - Number(b.localVersion !== undefined);
}

/** Whether `incoming` is an OLDER version of the message than `current`. */
export function isOlderCopy(current: MessageVersion, incoming: MessageVersion): boolean {
  if (incoming.localVersion?.unsettled === true) return false;
  if (current.localVersion?.unsettled === true) return true;
  const currentDeleted = current.deletedAt !== undefined;
  const incomingDeleted = incoming.deletedAt !== undefined;
  if (currentDeleted !== incomingDeleted) return currentDeleted;
  return compareVersions(incoming, current) < 0;
}

/** Merge `incoming` into `target` in place, by the rules in this module's doc. */
export function mergeCanonical<T extends MessageVersion>(
  target: T,
  incoming: Partial<T>,
  versionKeys: readonly (keyof T)[],
): void {
  const older = isOlderCopy(target, incoming);
  const versioned = new Set<keyof T>([...versionKeys, "editedAt", "deletedAt", "localVersion"]);
  if (!older) {
    for (const key of versioned) {
      if (key !== "deletedAt" && incoming[key] === undefined) delete target[key];
    }
  }
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    if (older && versioned.has(key)) continue;
    const value = incoming[key];
    if (value !== undefined) target[key] = value as T[keyof T];
  }
}
