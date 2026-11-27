/**
 * Published-key usability (OFSCP §4.3.2, §4.3.3).
 *
 * A verifier reads public keys from documents someone else publishes: a user's
 * keys response (§4.6) and `provider.publicKeys` in discovery (§3.1, §8.1).
 * Their schemas constrain an entry's `public_key` and `algorithm` only to
 * strings, so a document stays valid when one entry is unusable. Usability is
 * decided per entry, here:
 *
 *  - `algorithm` must be `"Ed25519"`, the only algorithm v0.1 defines (§4.3.3);
 *  - `public_key` must be the raw 32-byte Ed25519 key in padded standard base64
 *    ({@link Ed25519PublicKeySchema}, the one encoding §4.3.2 allows).
 *
 * An unusable entry is ignored on its own and counts as absent: the document's
 * other keys stay usable, and a request whose `X-OFSCP-Key-ID` names it fails
 * as for an unknown key (re-fetch per §4.6, then `401`, or `503` when that
 * fetch fails or is rate-limited). Keys a client SUBMITS (device-key
 * registration §4.3.1, guest creation §4.8) are not judged here: their schemas
 * require the exact form and a bad one is a `400`.
 */
import { Ed25519PublicKeySchema } from "./schemas/common.ts";

/** The fields of a published key entry that decide whether it is usable. */
export interface PublishedKeyEntry {
  readonly key_id: string;
  readonly algorithm: string;
  readonly public_key: string;
}

/** The only signing algorithm OFSCP v0.1 defines (§4.3.3). */
export const SUPPORTED_KEY_ALGORITHM = "Ed25519" as const;

/** True when a v0.1 verifier can use `entry`: Ed25519 and a raw 32-byte key (§4.3.2). */
export function isUsablePublishedKey(entry: Omit<PublishedKeyEntry, "key_id">): boolean {
  return (
    entry.algorithm === SUPPORTED_KEY_ALGORITHM &&
    Ed25519PublicKeySchema.safeParse(entry.public_key).success
  );
}

/**
 * The usable entry of `keys` whose `key_id` is `keyId`, or `null`. Unusable
 * entries are skipped as if absent (§4.3.2), so an unusable entry never hides
 * a usable one under the same id.
 */
export function findUsablePublishedKey<E extends PublishedKeyEntry>(
  keys: readonly E[],
  keyId: string,
): E | null {
  return keys.find((k) => k.key_id === keyId && isUsablePublishedKey(k)) ?? null;
}
