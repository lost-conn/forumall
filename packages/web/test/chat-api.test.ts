/**
 * Attachment kind classification (`lib/chat-api.ts`).
 *
 * `attachmentKind` is the SINGLE source of truth for how `AttachmentView`
 * picks an element (image/video/audio/file). These cases pin that the
 * classifier looks only at the mime *type* prefix — not, say, whether the
 * string merely CONTAINS "video/" somewhere, and not the codec parameters
 * that can trail a `;`.
 */
import { describe, expect, test } from "bun:test";
import type { Attachment } from "@forumall/shared";
import { attachmentKind, isImageAttachment } from "../src/lib/chat-api.ts";

/** A minimal attachment with the given mime; other fields are irrelevant to kind. */
function att(mime: string): Attachment {
  return { id: "a1", mime, url: "https://example.com/a1", size: 1 };
}

describe("attachmentKind", () => {
  test("image/png → image", () => {
    expect(attachmentKind(att("image/png"))).toBe("image");
  });

  test("video/mp4 → video", () => {
    expect(attachmentKind(att("video/mp4"))).toBe("video");
  });

  test("audio/mpeg → audio", () => {
    expect(attachmentKind(att("audio/mpeg"))).toBe("audio");
  });

  test("application/pdf → file", () => {
    expect(attachmentKind(att("application/pdf"))).toBe("file");
  });

  test("empty / garbage mime → file", () => {
    expect(attachmentKind(att(""))).toBe("file");
    expect(attachmentKind(att("not-a-mime"))).toBe("file");
  });

  test("mime with codec parameters after ';' is still classified by the type prefix", () => {
    expect(attachmentKind(att("video/mp4; codecs=avc1"))).toBe("video");
    expect(attachmentKind(att("audio/ogg; codecs=opus"))).toBe("audio");
  });

  test("a mime that merely CONTAINS 'video/' without starting with it is NOT video", () => {
    expect(attachmentKind(att("application/x-video/mp4"))).toBe("file");
    expect(attachmentKind(att("x-video/mp4"))).toBe("file");
  });
});

describe("isImageAttachment (thin wrapper over attachmentKind)", () => {
  test("agrees with attachmentKind === image", () => {
    expect(isImageAttachment(att("image/jpeg"))).toBe(true);
    expect(isImageAttachment(att("video/mp4"))).toBe(false);
    expect(isImageAttachment(att("application/pdf"))).toBe(false);
  });
});
