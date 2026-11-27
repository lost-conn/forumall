/**
 * `text/markdown` bodies (§5.3): CommonMark via markdown-it, raw HTML shown as
 * literal text, the link allow-list, `attachment:` references, and remote
 * images never loaded.
 */
import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../src/lib/content/markdown.ts";
import { markup } from "./helpers/body-markup.ts";

const DOMAIN = "a.test";
const md = (src: string): string => markup(parseMarkdown(src, DOMAIN).nodes);

describe("markdown — CommonMark blocks", () => {
  test("ATX and Setext headings", () => {
    expect(md("# Title")).toBe("<h1>Title</h1>");
    expect(md("### Sub")).toBe("<h3>Sub</h3>");
    expect(md("Title\n=====")).toBe("<h1>Title</h1>");
    expect(md("Sub\n---")).toBe("<h2>Sub</h2>");
  });

  test("tight and loose lists, ordered start", () => {
    expect(md("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(md("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(md("3. a\n4. b")).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
    expect(md("- a\n\n- b")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
  });

  test("blockquote, fenced and indented code, thematic break", () => {
    expect(md("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(md("```\nx<y\n```")).toBe("<pre><code>x&lt;y\n</code></pre>");
    expect(md("    code")).toBe("<pre><code>code\n</code></pre>");
    expect(md("a\n\n***\n\nb")).toBe("<p>a</p><hr><p>b</p>");
  });

  test("paragraphs, and a soft line break renders as a line break", () => {
    expect(md("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
    expect(md("one\ntwo")).toBe("<p>one<br>two</p>");
  });

  test("GFM extensions are not enabled: their syntax is text", () => {
    expect(md("~~x~~")).toBe("<p>~~x~~</p>");
    expect(md("| a |\n| - |\n| b |")).toBe("<p>| a |<br>| - |<br>| b |</p>");
  });
});

describe("markdown — inline", () => {
  test("bold, italic, code, nested emphasis", () => {
    expect(md("**b** _i_ `c`")).toBe("<p><strong>b</strong> <em>i</em> <code>c</code></p>");
    expect(md("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
    expect(md("***both***")).toBe("<p><em><strong>both</strong></em></p>");
  });

  test("CommonMark delimiter rules", () => {
    expect(md("snake_case_name")).toBe("<p>snake_case_name</p>");
    expect(md("a*b*c")).toBe("<p>a<em>b</em>c</p>");
    expect(md("5 * 3 * 2")).toBe("<p>5 * 3 * 2</p>");
    expect(md("**unclosed")).toBe("<p>**unclosed</p>");
    expect(md("`a*b*c`")).toBe("<p><code>a*b*c</code></p>");
  });

  test("backslash escapes and entities", () => {
    expect(md("\\*not bold\\*")).toBe("<p>*not bold*</p>");
    expect(md("C:\\path")).toBe("<p>C:\\path</p>");
    expect(md("`a\\*b`")).toBe("<p><code>a\\*b</code></p>");
    expect(md("&amp; &copy;")).toBe("<p>&amp; ©</p>");
  });

  test("mentions are recognised in text but not in code", () => {
    expect(md("hi @alice")).toBe(`<p>hi <mention actor="alice@${DOMAIN}">@alice</mention></p>`);
    expect(md("**@alice**")).toBe(
      `<p><strong><mention actor="alice@${DOMAIN}">@alice</mention></strong></p>`,
    );
    expect(md("`@alice`")).toBe("<p><code>@alice</code></p>");
  });
});

describe("markdown — raw HTML is literal text (§5.3 MUST NOT interpret)", () => {
  test("inline HTML", () => {
    expect(md("a <b>bold</b> c")).toBe("<p>a &lt;b&gt;bold&lt;/b&gt; c</p>");
    expect(md("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });

  test("HTML blocks", () => {
    expect(md("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(md("<div>\n*x*\n</div>")).toBe("<p>&lt;div&gt;<br><em>x</em><br>&lt;/div&gt;</p>");
  });

  test("an <h1> in Markdown is text, not a heading", () => {
    expect(md("<h1>T</h1>")).toBe("<p>&lt;h1&gt;T&lt;/h1&gt;</p>");
  });
});

describe("markdown — links (§5.3 allow-list)", () => {
  test("http, https and mailto are active", () => {
    expect(md("[s](https://e.com/a_b)")).toBe('<p><a href="https://e.com/a_b">s</a></p>');
    expect(md("[s](http://e.com)")).toBe('<p><a href="http://e.com">s</a></p>');
    expect(md("[m](mailto:x@e.com)")).toBe('<p><a href="mailto:x@e.com">m</a></p>');
    expect(md("<https://e.com>")).toBe('<p><a href="https://e.com">https://e.com</a></p>');
  });

  test("other schemes keep their text and lose the link", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "ftp://e.com", "tel:123"]) {
      expect(md(`[x](${href})`)).toBe("<p>x</p>");
    }
  });

  test("scheme-less and relative links are inactive (lost-conn/ofscp#31)", () => {
    for (const href of ["/foo", "#x", "//e.com/a", "page.html", "./a", "../a"]) {
      expect(md(`[x](${href})`)).toBe("<p>x</p>");
    }
  });

  test("control characters cannot smuggle a javascript: scheme", () => {
    // CommonMark does not take a destination containing a control character
    // as a link at all, so the source stays text; either way, no link.
    for (const ctrl of ["\u0001", "\u0008", "\u001f", "\u007f"]) {
      for (const src of [`[x](java${ctrl}script:alert(1))`, `[x](${ctrl}javascript:alert(1))`]) {
        const nodes = parseMarkdown(src, DOMAIN).nodes;
        expect(markup(nodes)).not.toContain("<a ");
      }
    }
    // An autolink is where the check itself matters; the link allow-list
    // strips the control characters before reading the scheme.
    expect(md("<java\u0001script:alert(1)>")).not.toContain("<a ");
  });

  test("markup inside a rejected link's label stays text", () => {
    expect(md("[<img src=x>](javascript:alert(1))")).toBe("<p>&lt;img src=x&gt;</p>");
  });

  test("attachment: links name the message's own attachment", () => {
    expect(md("[the file](attachment:att_1)")).toBe(
      '<p><att-link id="att_1">the file</att-link></p>',
    );
    expect(md("[x](attachment:)")).toBe("<p>x</p>");
  });

  test("a link label is not split into mentions", () => {
    expect(md("[@alice](https://e.com)")).toBe('<p><a href="https://e.com">@alice</a></p>');
  });
});

describe("markdown — images", () => {
  test("attachment: images place the attachment, with the caption", () => {
    expect(md("![The *first* meetup](attachment:att_2)")).toBe(
      '<p><att id="att_2" caption="The first meetup"></p>',
    );
  });

  test("a remote image is never loaded: it becomes a link with its alt text", () => {
    expect(md("![a cat](https://e.com/cat.png)")).toBe(
      '<p><remote-img href="https://e.com/cat.png" alt="a cat"></p>',
    );
  });

  test("an image with a disallowed or relative source is its alt text", () => {
    expect(md("![x](javascript:alert(1))")).toBe("<p>x</p>");
    expect(md("![x](/a.png)")).toBe("<p>x</p>");
    expect(md("![x](mailto:a@e.com)")).toBe("<p>x</p>");
  });

  test("referenced attachment ids are collected in body order", () => {
    const parsed = parseMarkdown(
      "![a](attachment:a2) [b](attachment:a1) ![c](https://e.com/c)",
      DOMAIN,
    );
    expect([...parsed.referencedAttachmentIds]).toEqual(["a2", "a1"]);
  });
});
