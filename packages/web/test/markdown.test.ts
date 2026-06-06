/**
 * Markdown renderer unit tests (P8): proves the `article` renderer covers the
 * common subset AND is XSS-safe by construction — raw HTML is escaped, unsafe
 * link schemes are dropped, and only the renderer's own tags appear in output.
 */
import { describe, expect, test } from "bun:test";
import { escapeHtml, renderMarkdown } from "../src/lib/markdown.ts";

describe("escapeHtml", () => {
  test("escapes all HTML metacharacters", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });
});

describe("renderMarkdown — formatting", () => {
  test("headings", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("### Sub")).toContain("<h3>Sub</h3>");
  });

  test("bold, italic, inline code", () => {
    const html = renderMarkdown("**b** _i_ `c`");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<code>c</code>");
  });

  test("unordered + ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("blockquote + fenced code", () => {
    expect(renderMarkdown("> quoted")).toBe("<blockquote>quoted</blockquote>");
    expect(renderMarkdown("```\nx<y\n```")).toBe("<pre><code>x&lt;y</code></pre>");
  });

  test("paragraphs separated by blank lines", () => {
    expect(renderMarkdown("one\n\ntwo")).toBe("<p>one</p>\n<p>two</p>");
  });

  test("safe links become anchors", () => {
    const html = renderMarkdown("[site](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain(">site</a>");
  });
});

describe("renderMarkdown — XSS safety", () => {
  test("raw HTML tags are escaped, never emitted live", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("script tags are inert", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("javascript: links collapse to plain text", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("x");
  });

  test("data: links collapse to plain text", () => {
    const html = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<a ");
  });
});
