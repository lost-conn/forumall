/**
 * Attachment gallery selection + navigation (`lib/attachment-gallery.ts`).
 *
 * These pin the two decisions behind the expanded media view: WHICH attachments
 * become lightbox slides (images + video only — never an audio track or a 📎
 * file, which would open a viewer with nothing in it), and where prev/next
 * lands (wrapping at both ends). The rest of the feature is markup, so this is
 * the layer worth unit-testing in a suite with no DOM harness.
 */
import { describe, expect, test } from "bun:test";
import type { Attachment } from "@forumall/shared";
import {
  expandableAttachments,
  expandableIndexOf,
  isExpandableAttachment,
  stepExpandIndex,
} from "../src/lib/attachment-gallery.ts";

/** A minimal attachment with the given id + mime; other fields are irrelevant here. */
function att(id: string, mime: string): Attachment {
  return { id, mime, url: `https://example.com/${id}`, size: 1 };
}

describe("isExpandableAttachment", () => {
  test("images and video expand", () => {
    expect(isExpandableAttachment(att("a", "image/png"))).toBe(true);
    expect(isExpandableAttachment(att("b", "video/mp4"))).toBe(true);
    // Codec parameters must not change the answer (kind comes from attachmentKind).
    expect(isExpandableAttachment(att("c", "video/mp4; codecs=avc1"))).toBe(true);
  });

  test("audio and files do NOT expand", () => {
    expect(isExpandableAttachment(att("d", "audio/mpeg"))).toBe(false);
    expect(isExpandableAttachment(att("e", "application/pdf"))).toBe(false);
    expect(isExpandableAttachment(att("f", ""))).toBe(false);
  });
});

describe("expandableAttachments", () => {
  test("keeps render order and drops non-expandable items", () => {
    const list = [
      att("1", "image/png"),
      att("2", "audio/mpeg"),
      att("3", "video/mp4"),
      att("4", "application/pdf"),
      att("5", "image/jpeg"),
    ];
    expect(expandableAttachments(list).map((a) => a.id)).toEqual(["1", "3", "5"]);
  });

  test("a list with nothing expandable yields no slides", () => {
    expect(expandableAttachments([att("1", "audio/ogg"), att("2", "text/plain")])).toEqual([]);
  });

  test("an empty list yields an empty list", () => {
    expect(expandableAttachments([])).toEqual([]);
  });
});

describe("expandableIndexOf", () => {
  const list = [
    att("1", "image/png"),
    att("2", "audio/mpeg"),
    att("3", "video/mp4"),
    att("4", "image/jpeg"),
  ];

  test("maps an attachment to its position among the SLIDES, not the full list", () => {
    // "3" is the 3rd attachment but only the 2nd slide — the audio was skipped.
    expect(expandableIndexOf(list, list[2] as Attachment)).toBe(1);
    expect(expandableIndexOf(list, list[3] as Attachment)).toBe(2);
    expect(expandableIndexOf(list, list[0] as Attachment)).toBe(0);
  });

  test("a non-expandable attachment has no slide (-1)", () => {
    expect(expandableIndexOf(list, list[1] as Attachment)).toBe(-1);
  });

  test("matches by id, so a re-fetched message object still resolves", () => {
    expect(expandableIndexOf(list, att("4", "image/jpeg"))).toBe(2);
  });

  test("an attachment that is not in the list at all is -1", () => {
    expect(expandableIndexOf(list, att("99", "image/png"))).toBe(-1);
  });
});

describe("stepExpandIndex (wrap-around, not clamp)", () => {
  test("steps forward and backward within range", () => {
    expect(stepExpandIndex(0, 1, 3)).toBe(1);
    expect(stepExpandIndex(2, -1, 3)).toBe(1);
  });

  test("next from the LAST slide wraps to the first", () => {
    expect(stepExpandIndex(2, 1, 3)).toBe(0);
  });

  test("prev from the FIRST slide wraps to the last", () => {
    expect(stepExpandIndex(0, -1, 3)).toBe(2);
  });

  test("a single slide always stays put", () => {
    expect(stepExpandIndex(0, 1, 1)).toBe(0);
    expect(stepExpandIndex(0, -1, 1)).toBe(0);
  });

  test("an empty gallery degrades to 0 rather than a negative/NaN index", () => {
    expect(stepExpandIndex(0, 1, 0)).toBe(0);
    expect(stepExpandIndex(0, -1, 0)).toBe(0);
  });
});
