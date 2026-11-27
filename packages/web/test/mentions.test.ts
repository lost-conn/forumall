/**
 * @mention helper unit tests — the pure client logic backing the composer
 * autocomplete and message-body highlighting (src/lib/mentions.ts).
 *
 * The match semantics MUST agree with the server (provider/notifications-feed.ts
 * `detectMentions`): the leading `@` only counts at start/after-whitespace (so an
 * email is not a mention), a bare `@handle` resolves to the local domain, and a
 * `@handle@domain` keeps its domain.
 */
import { describe, expect, test } from "bun:test";
import {
  detectActiveMentionQuery,
  mentionRefFor,
  mentionedActors,
  parseMentionSegments,
} from "../src/lib/mentions.ts";

const LOCAL = "forum.example";

describe("detectActiveMentionQuery", () => {
  test("detects an active query at the caret (start of input)", () => {
    const text = "@ali";
    expect(detectActiveMentionQuery(text, text.length)).toEqual({ start: 0, query: "ali" });
  });

  test("detects an empty query right after a fresh @", () => {
    const text = "hello @";
    expect(detectActiveMentionQuery(text, text.length)).toEqual({ start: 6, query: "" });
  });

  test("detects a query after whitespace mid-text", () => {
    const text = "hey @bob and";
    // caret right after "bob"
    expect(detectActiveMentionQuery(text, 8)).toEqual({ start: 4, query: "bob" });
  });

  test("returns null when the caret is after a space (mention ended)", () => {
    const text = "@alice ";
    expect(detectActiveMentionQuery(text, text.length)).toBeNull();
  });

  test("returns null mid-email (the @ is not preceded by whitespace)", () => {
    const text = "mail me a@b";
    expect(detectActiveMentionQuery(text, text.length)).toBeNull();
  });

  test("returns null when there is no @ before the caret", () => {
    const text = "just words";
    expect(detectActiveMentionQuery(text, text.length)).toBeNull();
  });
});

describe("mentionRefFor", () => {
  test("local member → bare handle", () => {
    expect(mentionRefFor(`alice@${LOCAL}`, LOCAL)).toBe("alice");
  });

  test("remote member → handle@domain", () => {
    expect(mentionRefFor("bob@other.example", LOCAL)).toBe("bob@other.example");
  });
});

describe("parseMentionSegments", () => {
  test("a bare mention resolves to the local domain", () => {
    const segs = parseMentionSegments("hi @alice", LOCAL);
    expect(segs).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", raw: "@alice", actor: `alice@${LOCAL}` },
    ]);
  });

  test("a qualified mention keeps its domain", () => {
    const segs = parseMentionSegments("yo @bob@other.example here", LOCAL);
    expect(segs).toEqual([
      { type: "text", value: "yo " },
      { type: "mention", raw: "@bob@other.example", actor: "bob@other.example" },
      { type: "text", value: " here" },
    ]);
  });

  test("an email is NOT treated as a mention", () => {
    const segs = parseMentionSegments("write to a@b.com please", LOCAL);
    expect(segs).toEqual([{ type: "text", value: "write to a@b.com please" }]);
  });

  test("multiple mentions with leading and trailing text", () => {
    const segs = parseMentionSegments("ping @alice and @carol@x.io ok", LOCAL);
    expect(segs).toEqual([
      { type: "text", value: "ping " },
      { type: "mention", raw: "@alice", actor: `alice@${LOCAL}` },
      { type: "text", value: " and " },
      { type: "mention", raw: "@carol@x.io", actor: "carol@x.io" },
      { type: "text", value: " ok" },
    ]);
  });

  test("plain text yields a single text segment", () => {
    expect(parseMentionSegments("nothing to see", LOCAL)).toEqual([
      { type: "text", value: "nothing to see" },
    ]);
  });

  test("a `.` ends the handle (§10.1: the longest run of [a-z0-9_-])", () => {
    expect(parseMentionSegments("hi @bob.smith.", LOCAL)).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", raw: "@bob", actor: `bob@${LOCAL}` },
      { type: "text", value: ".smith." },
    ]);
  });

  test("a trailing sentence `.` after a domain is not part of it", () => {
    expect(parseMentionSegments("ask @a_1@b.example.", LOCAL)).toEqual([
      { type: "text", value: "ask " },
      { type: "mention", raw: "@a_1@b.example", actor: "a_1@b.example" },
      { type: "text", value: "." },
    ]);
  });
});

describe("mentionedActors (§5.3 `mentions`)", () => {
  test("canonical actors in first-mention order, de-duplicated and lowercased", () => {
    expect(
      mentionedActors("@Bob and @carol@Other.Example, again @bob and @CAROL@other.example", LOCAL),
    ).toEqual([`bob@${LOCAL}`, "carol@other.example"]);
  });

  test("a bare handle names a user of the hosting provider, in canonical form", () => {
    expect(mentionedActors("hey @dave", "Forum.Example:443")).toEqual(["dave@forum.example"]);
    expect(mentionedActors("hey @dave", "localhost:8787")).toEqual(["dave@localhost:8787"]);
  });

  test("emails and text without mentions name nobody", () => {
    expect(mentionedActors("mail bob@example.com please", LOCAL)).toEqual([]);
    expect(mentionedActors("", LOCAL)).toEqual([]);
  });
});
