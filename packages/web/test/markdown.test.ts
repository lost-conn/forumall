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

/**
 * Inline emphasis is CommonMark-ish: delimiter runs are resolved by the inline
 * tokenizer, so no rule can corrupt another rule's output. Each case below was a
 * real bug in the old regex-cascade renderer (the previous output is quoted).
 */
describe("renderMarkdown — inline emphasis", () => {
  test("emphasis does not leak into a code span", () => {
    // was: <code>a<em>b</em>c</code>
    expect(renderMarkdown("`a*b*c`")).toBe("<p><code>a*b*c</code></p>");
  });

  test("a code span containing ** and _ stays literal", () => {
    expect(renderMarkdown("`**x** _y_`")).toBe("<p><code>**x** _y_</code></p>");
  });

  test("emphasis does not corrupt a link href", () => {
    // was: href="https://a.com/a<em>b</em>c"
    expect(renderMarkdown("[x](https://a.com/a_b_c)")).toBe(
      '<p><a href="https://a.com/a_b_c" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });

  test("emphasis inside a link label still renders (correct CommonMark)", () => {
    expect(renderMarkdown("[**bold** _it_](https://e.com)")).toBe(
      '<p><a href="https://e.com" target="_blank" rel="noopener noreferrer"><strong>bold</strong> <em>it</em></a></p>',
    );
  });

  test("underscores do not emphasize intraword", () => {
    // was: snake<em>case</em>name / file<em>name</em>here.txt
    expect(renderMarkdown("snake_case_name")).toBe("<p>snake_case_name</p>");
    expect(renderMarkdown("file_name_here.txt")).toBe("<p>file_name_here.txt</p>");
  });

  test("asterisks DO emphasize intraword (CommonMark allows it for *)", () => {
    expect(renderMarkdown("a*b*c")).toBe("<p>a<em>b</em>c</p>");
  });

  test("whitespace-flanked delimiters stay literal", () => {
    // was: 5 <em> 3 </em> 2
    expect(renderMarkdown("5 * 3 * 2")).toBe("<p>5 * 3 * 2</p>");
  });

  test("__strong__ is supported and ** works intraword", () => {
    // was: a<strong>b</strong>c and _<em>c</em>_
    expect(renderMarkdown("a**b**c and __c__")).toBe(
      "<p>a<strong>b</strong>c and <strong>c</strong></p>",
    );
  });

  test("*** and ___ produce both em and strong", () => {
    expect(renderMarkdown("***both***")).toBe("<p><em><strong>both</strong></em></p>");
    expect(renderMarkdown("___both___")).toBe("<p><em><strong>both</strong></em></p>");
  });

  test("unmatched delimiters stay literal text", () => {
    expect(renderMarkdown("*a")).toBe("<p>*a</p>");
    expect(renderMarkdown("a_b")).toBe("<p>a_b</p>");
    expect(renderMarkdown("**unclosed")).toBe("<p>**unclosed</p>");
    expect(renderMarkdown("closed only*")).toBe("<p>closed only*</p>");
  });

  test("nested emphasis", () => {
    expect(renderMarkdown("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
  });
});

describe("renderMarkdown — backslash escapes", () => {
  test("escaped delimiters render literally and the backslash is dropped", () => {
    // was: \<em>not bold\</em>
    expect(renderMarkdown("\\*not bold\\*")).toBe("<p>*not bold*</p>");
    expect(renderMarkdown("\\_not italic\\_")).toBe("<p>_not italic_</p>");
    expect(renderMarkdown("\\`not code\\`")).toBe("<p>`not code`</p>");
    expect(renderMarkdown("\\[not a link\\](x)")).toBe("<p>[not a link](x)</p>");
    expect(renderMarkdown("a \\\\ b")).toBe("<p>a \\ b</p>");
  });

  test("a backslash before a non-punctuation character is kept literally", () => {
    expect(renderMarkdown("C:\\path")).toBe("<p>C:\\path</p>");
  });

  test("backslashes do NOT escape inside a code span (CommonMark)", () => {
    expect(renderMarkdown("`a\\*b`")).toBe("<p><code>a\\*b</code></p>");
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

  /**
   * A C0 control character inside the destination used to defeat the scheme
   * check: `safeHref` saw a string starting `java\u2026`, decided it had no
   * scheme, and waved it through as a relative path \u2014 but a browser STRIPS
   * control characters while parsing a URL, so the emitted href navigated as
   * `javascript:`. The destination is now sanitized BEFORE the check, and what
   * we validated is exactly what we emit.
   */
  test("control characters cannot smuggle a javascript: scheme past the check", () => {
    for (const ctrl of ["\u0000", "\u0001", "\u0008", "\u001f", "\u007f"]) {
      const html = renderMarkdown(`[x](java${ctrl}script:alert(1))`);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain(ctrl);
    }
    // A LEADING control character must not hide the scheme either.
    const lead = renderMarkdown("[x](\u0001javascript:alert(1))");
    expect(lead).not.toContain("<a ");
    expect(lead).not.toContain("javascript:");
  });

  test("a sanitized href is emitted exactly as validated", () => {
    const html = renderMarkdown("[x](https://e.com/a\u0001b)");
    expect(html).toContain('href="https://e.com/ab"');
    expect(html).not.toContain("\u0001");
  });

  test("markup inside a rejected link's label is still escaped", () => {
    const html = renderMarkdown("[<img src=x onerror=alert(1)>](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<a ");
  });

  test("quotes in an href cannot break out of the attribute", () => {
    const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
    expect(html).toContain("&quot;onmouseover=&quot;");
    expect(html).not.toContain('"onmouseover="');
  });

  /**
   * The inline renderer resolves emphasis over a NODE TREE, not over a string of
   * generated HTML — code bodies and link hrefs are opaque payloads, so there is
   * no placeholder/sentinel token to forge and no restore step to confuse. These
   * cases pin that: text that looks like a placeholder is just text.
   */
  test("placeholder-looking input is inert text, not markup", () => {
    const html = renderMarkdown("\u0000CODE0\u0000 %%LINK1%% \uE000x\uE000 \uFFFC");
    expect(html).not.toContain("<code");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<em");
    expect(html).toContain("CODE0");
    expect(html).toContain("%%LINK1%%");
  });

  test("a code span containing placeholder-looking text stays literal", () => {
    expect(renderMarkdown("`\u0001CODE0\u0001`")).toBe("<p><code>\u0001CODE0\u0001</code></p>");
    expect(renderMarkdown("`%%LINK0%%`")).toBe("<p><code>%%LINK0%%</code></p>");
  });

  test("a backslash before placeholder-looking text smuggles nothing", () => {
    // `\%` escapes to a literal `%` (ASCII punctuation); `\` + NUL is not an
    // escape at all, so the backslash survives. Neither can start a construct.
    const html = renderMarkdown("\\ CODE0 \\%%LINK0%%");
    expect(html).not.toContain("<code");
    expect(html).not.toContain("<a ");
    expect(html).toBe("<p>\\ CODE0 %%LINK0%%</p>");
  });
});
