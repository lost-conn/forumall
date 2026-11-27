/**
 * Client-side @mention helpers — shared, pure logic for the channel composer's
 * autocomplete and for rendering mentions as styled tokens in messages.
 *
 * These mirror the SERVER's mention semantics (provider/notifications-feed.ts
 * `detectMentions` / `MENTION_RE`) byte-for-byte where it matters, so that what
 * the composer autocompletes and what the client highlights is EXACTLY what the
 * server will parse into a mention notification — the §10.1 text rule. The
 * same rule fills a sent message's `mentions` (§5.3), so the list the client
 * sends is exactly what the text names.
 *
 * Four responsibilities:
 *  - {@link detectActiveMentionQuery} — the composer's "am I typing a mention
 *    right now?" probe (caret-relative);
 *  - {@link mentionRefFor} — the bare token to insert for a member;
 *  - {@link parseMentionSegments} — split a finished message body into plain +
 *    mention segments for styled rendering;
 *  - {@link mentionedActors} — the canonical actors a message's text names, for
 *    its `mentions` field.
 */
import { canonicalActor, canonicalAuthority } from "@forumall/shared";

/**
 * The match rule mirror of the server's `MENTION_RE` (notifications-feed.ts),
 * which is OFSCP §10.1's:
 *  - the leading `@` must NOT be preceded by a word char or another `@` (so an
 *    email `a@b.com` does NOT register as a bare mention of `b.com`);
 *  - the handle is the longest run of handle characters (`[a-z0-9_-]`, §2.2.1),
 *    so a `.` ends it (`@alice.` and `@alice.smith` both name `alice`);
 *  - an optional `@domain` suffix matches a dotted host or `localhost[:port]`.
 *
 * Kept in sync with the server: if you change one, change the other.
 */
const MENTION_RE =
  /(?<![\w@])@([a-z0-9_-]+)(?:@([a-z0-9.-]+\.[a-z]{2,}|localhost(?::\d+)?))?(?![a-z0-9_-])/gi;

/**
 * Looking back from `caret`, detect an active mention being typed: an `@` that is
 * at index 0 or preceded by whitespace, followed by zero+ chars that are NOT
 * whitespace and NOT another `@`, ending exactly at `caret`.
 *
 * Returns the `@`'s index as `start` and the raw chars after the `@` as `query`
 * (callers lowercase for matching). Returns null when no active mention applies
 * (caret after a space, or mid-email like `a@b` where the `@` is not preceded by
 * whitespace/start).
 */
export function detectActiveMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  // Scan back from the caret for the nearest `@`, bailing on whitespace (a space
  // ends any in-progress mention) or a second `@` (e.g. an email's `@`).
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i] as string;
    if (ch === "@") {
      // The `@` qualifies only if it is at the start or preceded by whitespace.
      const prev = i > 0 ? (text[i - 1] as string) : "";
      if (i === 0 || /\s/.test(prev)) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * The token to insert for `memberUser` (`handle@domain`), WITHOUT the leading
 * `@`: a bare `handle` when it is local (`domain === localDomain`), else the
 * fully-qualified `handle@domain`. (Callers insert `@${ref} `.)
 */
export function mentionRefFor(memberUser: string, localDomain: string): string {
  const at = memberUser.lastIndexOf("@");
  if (at < 0) return memberUser;
  const handle = memberUser.slice(0, at);
  const domain = memberUser.slice(at + 1);
  return domain === localDomain ? handle : `${handle}@${domain}`;
}

/** A run of plain text. */
export interface TextSegment {
  readonly type: "text";
  readonly value: string;
}

/** A matched `@mention` with its literal token and resolved canonical actor. */
export interface MentionSegment {
  readonly type: "mention";
  /** The literal matched token, e.g. `@alice` or `@bob@other.example`. */
  readonly raw: string;
  /** The resolved actor `handle@domain` (bare → `localDomain`). */
  readonly actor: string;
}

export type MentionSegmentNode = TextSegment | MentionSegment;

/**
 * Split `text` into plain + mention segments using the SAME match rule as the
 * server `detectMentions`. Each mention's `raw` is the literal matched token and
 * `actor` is the resolved canonical `handle@domain` (`@handle` → `localDomain`;
 * `@handle@domain` keeps its domain). Emails are NOT treated as mentions.
 *
 * A domain ends with a letter label, so a trailing `.` after it belongs to the
 * sentence (`@a@b.com.` names `a@b.com`), as on the server.
 */
export function parseMentionSegments(text: string, localDomain: string): MentionSegmentNode[] {
  const out: MentionSegmentNode[] = [];
  let last = 0;
  // Fresh regex per call: it is /g/ (stateful lastIndex).
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  for (const m of text.matchAll(re)) {
    const handle = (m[1] ?? "").toLowerCase();
    if (!handle) continue;
    const start = m.index ?? 0;
    const raw = m[0];
    if (start > last) out.push({ type: "text", value: text.slice(last, start) });
    const domain = (m[2] ?? localDomain).toLowerCase();
    out.push({ type: "mention", raw, actor: `${handle}@${domain}` });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/**
 * The users `text` names (§10.1 rule above), as the canonical actors (§2.2) a
 * message's `mentions` field carries (§5.3): first-mention order, no
 * duplicates. A bare `@handle` names a user of `hostingAuthority`, the provider
 * that will hold the message. A token that is not a valid actor (a junk domain)
 * is left out rather than sent, since a provider rejects a message whose
 * `mentions` holds a non-canonical actor it does not convert (§7.1).
 */
export function mentionedActors(text: string, hostingAuthority: string): string[] {
  const local = canonicalAuthority(hostingAuthority);
  const out: string[] = [];
  for (const seg of parseMentionSegments(text, local)) {
    if (seg.type !== "mention") continue;
    const actor = canonicalActor(seg.actor);
    if (actor !== null && !out.includes(actor)) out.push(actor);
  }
  return out;
}
