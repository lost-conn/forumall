/**
 * Deterministic DM conversation-id derivation (spec §7.4, "Conversation id").
 *
 * Both parties — possibly on different providers — derive the same `dmId` from
 * the two participants with no prior coordination, so this must be byte-exact:
 * a wrong derivation poisons DM routing. Validated against the spec vector
 * (`alice@a.com` + `bob@b.com`).
 *
 * Imported by both the server (DM storage/routing) and the web client (send).
 */
import { sha256 } from "@noble/hashes/sha2";

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Canonicalize a participant to its lowercase `handle@domain` actor form
 * (§2.2). Surrounding whitespace is trimmed (a stray space from UI/copy-paste
 * must not fork the conversation id); the actor must be non-empty and contain
 * an `@`. Lowercasing is ASCII/locale-independent via `toLowerCase()`, which is
 * sufficient for the `handle@domain` actor forms OFSCP v0.1 defines.
 */
function canonicalizeActor(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed.length === 0 || !trimmed.includes("@")) {
    throw new Error(
      `invalid actor for dmId derivation: ${JSON.stringify(actor)} (expected handle@domain)`,
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Derive the deterministic `dmId` for a two-participant DM (spec §7.4).
 *
 * Steps: canonicalize+lowercase each actor, sort the two strings in ascending
 * Unicode code-point order, join with a single LF (no trailing newline), then
 * `dm_` + lowercase-hex SHA-256 of the UTF-8 bytes.
 *
 * Order-independent: `deriveDmId(a, b) === deriveDmId(b, a)`.
 *
 * @example
 * deriveDmId("alice@a.com", "bob@b.com")
 * // → "dm_c2a3a0d4bc7aa54700d2f412c42fc0155df6071e502977e4988933eef7e46868"
 */
export function deriveDmId(actorA: string, actorB: string): string {
  const a = canonicalizeActor(actorA);
  const b = canonicalizeActor(actorB);
  // Ascending Unicode code-point order. The actors are lowercase ASCII
  // `handle@domain` forms, for which `<` over JS strings is code-point order.
  const [first, second] = a <= b ? [a, b] : [b, a];
  const canonical = `${first}\n${second}`;
  return `dm_${toHex(sha256(utf8.encode(canonical)))}`;
}
