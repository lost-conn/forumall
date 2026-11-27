import { beforeEach, describe, expect, test } from "bun:test";
/**
 * A merge makes the stored message mirror the newer canonical copy for every
 * optional field (`lib/merge-message.ts`): an edit that REMOVES an article's
 * `title`, `summary` or `cover` (or a reply `reference`, attachments…) clears
 * it, so the §5.3 leading-H1 title fallback applies again. The merge stays in
 * place (row identity is kept), and local bookkeeping (`cursor`, echo state,
 * a DM's `mine`) survives a copy that omits it.
 */
import type { Attachment, Message } from "@forumall/shared";
import { toChatMessage } from "../src/components/chat/chat-controller.ts";
import { articleView, attachmentLayout, parseBody } from "../src/lib/content/body.ts";
import {
  addOptimistic,
  applyEdit,
  clearChat,
  messagesFor,
  prependHistory,
  reconcileOptimistic,
  tombstoneMessage,
  upsertMessage,
} from "../src/stores/chat.ts";
import {
  applyDmEdit,
  clearDms,
  dmThread,
  tombstoneDmMessage,
  upsertDmMessage,
} from "../src/stores/dms.ts";

/** The first item of a list, failing the test when there is none. */
function at<T>(list: readonly T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new Error(`no item at ${i}`);
  return item;
}

const CH = "ch_merge";
const DM = "dm_merge";

const cover: Attachment = { id: "att_c", mime: "image/png", url: "https://cdn.a.test/c", size: 1 };

const article = (over: Partial<Message>): Message => ({
  id: "m1",
  author: "a@a.test",
  type: "article",
  content: { mime: "text/markdown", text: "# Body heading\n\nText." },
  attachments: [cover],
  createdAt: "2026-11-27T00:00:00Z",
  metadata: [],
  ...over,
});

const titled = article({ title: "Field title", summary: "S", cover: "att_c", tags: ["t"] });

/** The stored message's rendered title (the §5.3 rule over its current body). */
const shownTitle = (): string | null => {
  const m = at(messagesFor(CH), 0);
  return articleView(m, parseBody(m.content, "a.test")).title;
};

beforeEach(() => {
  clearChat();
  clearDms();
});

describe("chat store: an edit that removes optional fields clears them", () => {
  test("removing title, summary and cover: cleared in place, then the H1 fallback applies", () => {
    upsertMessage(CH, toChatMessage(titled, "c1"));
    const stored = at(messagesFor(CH), 0);
    expect(shownTitle()).toBe("Field title");

    applyEdit(CH, toChatMessage(article({ editedAt: "2026-11-27T00:01:00Z" }), "c1"));

    expect(at(messagesFor(CH), 0)).toBe(stored);
    expect("title" in stored || "summary" in stored || "cover" in stored).toBe(false);
    expect("tags" in stored).toBe(false);
    expect(shownTitle()).toBe("Body heading");
    expect(attachmentLayout(stored, new Set()).cover).toBeUndefined();
    expect(stored.cursor).toBe("c1");
  });

  test("a same-version history overlap without the fields clears them too", () => {
    const edited = { editedAt: "2026-11-27T00:01:00Z" };
    upsertMessage(CH, toChatMessage(article({ ...titled, ...edited }), "c1"));
    prependHistory(CH, [toChatMessage(article(edited), "c1")]);
    expect(messagesFor(CH)).toHaveLength(1);
    expect(shownTitle()).toBe("Body heading");
  });

  test("a newer edit clears removed fields over an older edit", () => {
    upsertMessage(CH, toChatMessage(article({ ...titled, editedAt: "2026-11-27T00:01:00Z" })));
    applyEdit(CH, toChatMessage(article({ editedAt: "2026-11-27T00:02:00Z" })));
    const stored = at(messagesFor(CH), 0);
    expect("title" in stored || "cover" in stored).toBe(false);
    expect(stored.editedAt).toBe("2026-11-27T00:02:00Z");
  });

  test("a reply reference removed by an edit is cleared", () => {
    upsertMessage(CH, {
      id: "m2",
      author: "a@a.test",
      content: { text: "x" },
      reference: { type: "reply", id: "m0" },
    });
    applyEdit(CH, { id: "m2", author: "a@a.test", content: { text: "y" }, editedAt: "t" });
    expect(at(messagesFor(CH), 0).reference).toBeUndefined();
  });

  test("echo reconciliation mirrors the canonical copy but keeps the cursor", () => {
    addOptimistic(CH, {
      id: "optimistic:cmid_1",
      author: "a@a.test",
      type: "article",
      title: "Draft title",
      cover: "att_c",
      content: { mime: "text/markdown", text: "# Body heading" },
      clientMessageId: "cmid_1",
    });
    const echo = at(messagesFor(CH), 0);
    reconcileOptimistic(
      CH,
      "cmid_1",
      toChatMessage(article({ id: "m_real", clientMessageId: "cmid_1" }), "c9"),
    );
    expect(at(messagesFor(CH), 0)).toBe(echo);
    expect(echo.title).toBeUndefined();
    expect(echo.cover).toBeUndefined();
    expect(echo.pending).toBe(false);

    // A later copy without a cursor (a duplicate-create answer) keeps the stored one.
    upsertMessage(CH, { ...toChatMessage(article({ id: "m_real" })), cursor: undefined });
    expect(echo.cursor).toBe("c9");
  });
});

describe("chat store: replyCount is listing metadata, not a message field", () => {
  test("a live edit without replyCount keeps the stored count; a present one replaces it", () => {
    prependHistory(CH, [toChatMessage(article({ replyCount: 3 }), "c1")]);
    const stored = at(messagesFor(CH), 0);
    expect(stored.replyCount).toBe(3);

    applyEdit(CH, toChatMessage(article({ editedAt: "2026-11-27T00:01:00Z" }), "c1"));
    expect(at(messagesFor(CH), 0)).toBe(stored);
    expect(stored.replyCount).toBe(3);
    expect(stored.editedAt).toBe("2026-11-27T00:01:00Z");

    prependHistory(CH, [toChatMessage(article({ replyCount: 5 }), "c1")]);
    expect(stored.replyCount).toBe(5);
  });
});

describe("chat store: an older copy never undoes a newer edit or delete", () => {
  test("an edit racing an older history page keeps the edit", () => {
    upsertMessage(CH, toChatMessage(titled, "c1"));
    const edit = article({
      content: { mime: "text/markdown", text: "Edited." },
      editedAt: "2026-11-27T00:01:00Z",
    });
    applyEdit(CH, toChatMessage(edit, "c1"));
    // A page fetched before the edit lands after it: unedited, with the old
    // title, and a replyCount (listing metadata, still taken).
    prependHistory(CH, [toChatMessage({ ...titled, replyCount: 2 }, "c1")]);
    const stored = at(messagesFor(CH), 0);
    expect(stored.content.text).toBe("Edited.");
    expect(stored.editedAt).toBe("2026-11-27T00:01:00Z");
    expect("title" in stored).toBe(false);
    expect(stored.replyCount).toBe(2);

    // An earlier edit than the stored one is older too.
    applyEdit(CH, toChatMessage(article({ ...titled, editedAt: "2026-11-27T00:00:30Z" })));
    expect(stored.content.text).toBe("Edited.");
    expect(stored.editedAt).toBe("2026-11-27T00:01:00Z");
  });

  test("a tombstone survives a later copy without deletedAt", () => {
    upsertMessage(CH, toChatMessage(titled, "c1"));
    tombstoneMessage(CH, "m1", "2026-11-27T00:05:00Z");
    prependHistory(CH, [toChatMessage(titled, "c1")]);
    upsertMessage(CH, toChatMessage(article({ editedAt: "2026-11-27T00:01:00Z" }), "c1"));
    const stored = at(messagesFor(CH), 0);
    expect(stored.deletedAt).toBe("2026-11-27T00:05:00Z");
    expect(stored.content.text).toBe("");
    expect(stored.attachments).toEqual([]);
  });
});

describe("DM store: an older copy never undoes a newer edit or delete", () => {
  const dm = (over: Record<string, unknown>) => ({
    id: "d1",
    author: "b@b.test",
    content: { text: "x" },
    createdAt: "2026-11-27T00:00:00Z",
    mine: false,
    ...over,
  });

  test("an edit racing an older history page keeps the edit", () => {
    upsertDmMessage(DM, dm({ reference: { type: "reply", id: "d0" }, cursor: "c1" }));
    applyDmEdit(DM, dm({ content: { text: "edited" }, editedAt: "2026-11-27T00:01:00Z" }));
    upsertDmMessage(DM, dm({ reference: { type: "reply", id: "d0" }, cursor: "c2" }));
    const stored = at(dmThread(DM), 0);
    expect(stored.content.text).toBe("edited");
    expect(stored.editedAt).toBe("2026-11-27T00:01:00Z");
    expect(stored.reference).toBeUndefined();
    expect(stored.cursor).toBe("c2");
  });

  test("a tombstone survives a later copy without deletedAt", () => {
    upsertDmMessage(DM, dm({ cursor: "c1" }));
    tombstoneDmMessage(DM, "d1", "2026-11-27T00:05:00Z");
    upsertDmMessage(DM, dm({}));
    applyDmEdit(DM, dm({ content: { text: "late edit" }, editedAt: "2026-11-27T00:01:00Z" }));
    const stored = at(dmThread(DM), 0);
    expect(stored.deletedAt).toBe("2026-11-27T00:05:00Z");
    expect(stored.content.text).toBe("");
  });
});

describe("DM store: an edit that removes optional fields clears them", () => {
  test("attachments and reference removed by an edit are cleared; local fields kept", () => {
    upsertDmMessage(DM, {
      id: "d1",
      author: "b@b.test",
      content: { text: "x" },
      attachments: [cover],
      reference: { type: "reply", id: "d0" },
      createdAt: "2026-11-27T00:00:00Z",
      cursor: "c1",
      mine: false,
    });
    const stored = at(dmThread(DM), 0);
    applyDmEdit(DM, {
      id: "d1",
      author: "b@b.test",
      content: { text: "y" },
      createdAt: "2026-11-27T00:00:00Z",
      editedAt: "2026-11-27T00:01:00Z",
    });
    expect(at(dmThread(DM), 0)).toBe(stored);
    expect(stored.attachments).toBeUndefined();
    expect(stored.reference).toBeUndefined();
    expect(stored.content.text).toBe("y");
    expect(stored.cursor).toBe("c1");
    expect(stored.mine).toBe(false);
  });
});
