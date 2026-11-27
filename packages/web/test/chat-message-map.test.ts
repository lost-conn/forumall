import { describe, expect, test } from "bun:test";
/**
 * `toChatMessage` keeps the §5.3 article fields the renderer needs (`title`,
 * `summary`, `cover`), and adds none to a message that has none.
 */
import type { Message } from "@forumall/shared";
import { toChatMessage } from "../src/components/chat/chat-controller.ts";

const message = (over: Partial<Message>): Message => ({
  id: "m1",
  author: "a@h.test",
  type: "article",
  content: { mime: "text/markdown", text: "x" },
  attachments: [],
  createdAt: "2026-11-27T00:00:00Z",
  metadata: [],
  ...over,
});

describe("toChatMessage — article fields", () => {
  test("title, summary and cover are carried", () => {
    const m = toChatMessage(message({ title: "T", summary: "S", cover: "att_1" }));
    expect(m.title).toBe("T");
    expect(m.summary).toBe("S");
    expect(m.cover).toBe("att_1");
  });

  test("absent fields stay absent", () => {
    const m = toChatMessage(message({}));
    expect("title" in m || "summary" in m || "cover" in m).toBe(false);
  });
});
