import { describe, expect, test } from "bun:test";
/**
 * Body presentation rules (§5.3): dispatch on `content.mime`, the article
 * title rule, and attachment layout.
 */
import type { Attachment } from "@forumall/shared";
import {
  COMPOSED_MIME,
  articleSummary,
  articleView,
  attachmentLayout,
  bodyFormat,
  parseBody,
} from "../src/lib/content/body.ts";
import { markup } from "./helpers/body-markup.ts";

const DOMAIN = "a.test";
const body = (mime: string | undefined, text: string) => parseBody({ mime, text }, DOMAIN);

describe("dispatch on content.mime", () => {
  test("formats", () => {
    expect(bodyFormat("text/plain")).toBe("plain");
    expect(bodyFormat("text/markdown")).toBe("markdown");
    expect(bodyFormat("Text/Markdown; charset=utf-8")).toBe("markdown");
    expect(bodyFormat("text/html")).toBe("html");
  });

  test("what the composers send renders back as Markdown", () => {
    expect(COMPOSED_MIME).toBe("text/markdown");
    expect(bodyFormat(COMPOSED_MIME)).toBe("markdown");
    expect(markup(body(COMPOSED_MIME, "**bold**").nodes)).toContain("<strong>bold</strong>");
  });

  test("unsupported or missing mime falls back to text", () => {
    expect(bodyFormat("application/json")).toBe("plain");
    expect(bodyFormat("text/enriched")).toBe("plain");
    expect(bodyFormat(undefined)).toBe("plain");
  });

  test("text/plain is shown as is: no Markdown, no HTML", () => {
    const src = "**bold** [x](https://e.com) <b>t</b>\n# not a heading";
    expect(markup(body("text/plain", src).nodes)).toBe(
      "**bold** [x](https://e.com) &lt;b&gt;t&lt;/b&gt;\n# not a heading",
    );
  });

  test("text/plain keeps mentions and has no attachment references", () => {
    const parsed = body("text/plain", "hi @alice ![x](attachment:a1)");
    expect(markup(parsed.nodes)).toBe(
      `hi <mention actor="alice@${DOMAIN}">@alice</mention> ![x](attachment:a1)`,
    );
    expect(parsed.referencedAttachmentIds.size).toBe(0);
  });

  test("the same source renders per mime", () => {
    expect(markup(body("text/markdown", "**b**").nodes)).toBe("<p><strong>b</strong></p>");
    expect(markup(body("text/html", "**b**").nodes)).toBe("**b**");
    expect(markup(body("text/html", "<b>b</b>").nodes)).toBe("<b>b</b>");
    expect(markup(body("text/x-unknown", "<b>b</b>").nodes)).toBe("&lt;b&gt;b&lt;/b&gt;");
  });
});

describe("article title (§5.3)", () => {
  const view = (msg: { title?: string }, mime: string, text: string) => {
    const v = articleView(msg, body(mime, text));
    return { title: v.title, body: markup(v.nodes) };
  };

  test("the title field wins and the body is shown whole", () => {
    expect(view({ title: "Field" }, "text/markdown", "# Heading\n\nx")).toEqual({
      title: "Field",
      body: "<h1>Heading</h1><p>x</p>",
    });
  });

  test("ATX level-1 first block becomes the title and is hidden from the body", () => {
    expect(view({}, "text/markdown", "# Hello *world*\n\nbody")).toEqual({
      title: "Hello world",
      body: "<p>body</p>",
    });
  });

  test("Setext level-1 first block", () => {
    expect(view({}, "text/markdown", "Hello\n=====\n\nbody")).toEqual({
      title: "Hello",
      body: "<p>body</p>",
    });
  });

  test("HTML <h1> first block", () => {
    expect(view({}, "text/html", "\n <h1>Hi</h1><p>b</p>")).toEqual({
      title: "Hi",
      body: "<p>b</p>",
    });
  });

  test("a level-1 heading that is not the first block is not a title", () => {
    expect(view({}, "text/markdown", "intro\n\n# Later")).toEqual({
      title: null,
      body: "<p>intro</p><h1>Later</h1>",
    });
    expect(view({}, "text/html", "<p>x</p><h1>Later</h1>").title).toBeNull();
  });

  test("a level-2 first block is not a title", () => {
    expect(view({}, "text/markdown", "## Sub\n\nx").title).toBeNull();
    expect(view({}, "text/markdown", "Sub\n---\n\nx").title).toBeNull();
  });

  test("no heading: untitled, with no first-line fallback", () => {
    expect(view({}, "text/markdown", "just text")).toEqual({
      title: null,
      body: "<p>just text</p>",
    });
  });

  test("text/plain never has a heading title", () => {
    expect(view({}, "text/plain", "# Not a title").title).toBeNull();
  });

  test("a present but blank title is untitled: no body fallback, the heading stays", () => {
    expect(view({ title: "  " }, "text/markdown", "# T\n\nx")).toEqual({
      title: null,
      body: "<h1>T</h1><p>x</p>",
    });
    expect(view({ title: "" }, "text/html", "<h1>T</h1>").title).toBeNull();
  });

  test("summary: the field, else the shown body as plain text", () => {
    const v = articleView({}, body("text/markdown", "# T\n\nFirst *para*.\n\n- item"));
    expect(articleSummary({ summary: "S" }, v)).toBe("S");
    expect(articleSummary({}, v)).toBe("First para. item");
    // Present (even blank) is the summary: deriving is only for an absent one.
    expect(articleSummary({ summary: "" }, v)).toBe("");
  });
});

describe("attachment layout (§5.3)", () => {
  const att = (id: string, mime = "image/png"): Attachment => ({
    id,
    mime,
    url: `https://cdn.e.com/${id}`,
    size: 1,
  });
  const ids = (list: Attachment[]) => list.map((a) => a.id);

  test("unreferenced attachments follow the body in attachments order", () => {
    const msg = { type: "message", attachments: [att("a1"), att("a2"), att("a3")] };
    const parsed = body("text/markdown", "![x](attachment:a2)");
    const layout = attachmentLayout(msg, parsed.referencedAttachmentIds);
    expect(ids(layout.trailing)).toEqual(["a1", "a3"]);
    expect(layout.cover).toBeUndefined();
  });

  test("link references count as references too", () => {
    const msg = { attachments: [att("a1"), att("a2")] };
    const parsed = body("text/markdown", "[file](attachment:a1)");
    expect(ids(attachmentLayout(msg, parsed.referencedAttachmentIds).trailing)).toEqual(["a2"]);
  });

  test("an article's cover is shown as the cover, not after the body", () => {
    const msg = { type: "article", cover: "a2", attachments: [att("a1"), att("a2")] };
    const layout = attachmentLayout(msg, new Set());
    expect(layout.cover?.id).toBe("a2");
    expect(ids(layout.trailing)).toEqual(["a1"]);
  });

  test("cover is ignored on other types and when it names no attachment", () => {
    expect(
      attachmentLayout({ type: "memo", cover: "a1", attachments: [att("a1")] }, new Set()).cover,
    ).toBeUndefined();
    const missing = attachmentLayout(
      { type: "article", cover: "zz", attachments: [att("a1")] },
      new Set(),
    );
    expect(missing.cover).toBeUndefined();
    expect(ids(missing.trailing)).toEqual(["a1"]);
  });

  test("a text/plain body references nothing, so every attachment trails", () => {
    const parsed = body("text/plain", "![x](attachment:a1)");
    expect(
      ids(attachmentLayout({ attachments: [att("a1")] }, parsed.referencedAttachmentIds).trailing),
    ).toEqual(["a1"]);
  });
});
