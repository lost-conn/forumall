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
import type { Attachment, Message } from "@forumall/shared";
import {
  attachmentKind,
  fetchHistory,
  fetchReplies,
  isImageAttachment,
} from "../src/lib/chat-api.ts";
import type { OfscpClient } from "../src/lib/ofscp-client.ts";

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

describe("history and reply fetches return messages only (§7.2, lost-conn/ofscp#37)", () => {
  const message = (id: string, over: Partial<Message> = {}): Message =>
    ({
      id,
      author: "alice@h",
      type: "message",
      content: { mime: "text/plain", text: id },
      createdAt: "2026-06-05T00:00:00Z",
      cursor: `c_${id}`,
      ...over,
    }) as Message;

  /** A client that answers every GET with `body` and records the paths. */
  function clientAnswering(body: unknown) {
    const gets: string[] = [];
    const client = {
      async get(path: string) {
        gets.push(path);
        return { data: body };
      },
    } as unknown as OfscpClient;
    return { client, gets };
  }

  test("fetchHistory returns the page's items as messages, tombstones included", async () => {
    const items = [message("m2", { deletedAt: "2026-06-05T00:01:00Z" }), message("m1")];
    const { client, gets } = clientAnswering({ items, page: { nextCursor: "c_next" } });
    const page = await fetchHistory(client, "g1", "ch1", { limit: 2 });
    expect(gets).toEqual(["/api/groups/g1/channels/ch1/messages?limit=2&direction=backward"]);
    // Exactly messages + cursor: no reaction split survives the narrowing.
    expect(Object.keys(page).sort()).toEqual(["messages", "nextCursor"]);
    expect(page.messages).toEqual(items);
    expect(page.nextCursor).toBe("c_next");
  });

  test("fetchHistory with no items and no cursor is an empty last page", async () => {
    const { client } = clientAnswering({ items: [], page: {} });
    expect(await fetchHistory(client, "g1", "ch1")).toEqual({ messages: [], nextCursor: null });
  });

  test("fetchReplies returns the reply items as messages, oldest-first by default", async () => {
    const items = [message("r1", { reference: { type: "message", id: "p1" } })];
    const { client, gets } = clientAnswering({ items, page: {} });
    const page = await fetchReplies(client, "g1", "ch1", "p1");
    expect(gets).toEqual(["/api/groups/g1/channels/ch1/messages/p1/replies?direction=forward"]);
    expect(Object.keys(page).sort()).toEqual(["messages", "nextCursor"]);
    expect(page.messages).toEqual(items);
    expect(page.nextCursor).toBeNull();
  });
});
