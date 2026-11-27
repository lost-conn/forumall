/**
 * `text/html` bodies (§5.3): the allow-list sanitizer.
 */
import { describe, expect, test } from "bun:test";
import { parseHtml } from "../src/lib/content/html.ts";
import { markup } from "./helpers/body-markup.ts";

const DOMAIN = "a.test";
const html = (src: string): string => markup(parseHtml(src, DOMAIN).nodes);

describe("html sanitizer — elements", () => {
  test("allow-listed elements are kept", () => {
    expect(
      html("<p><strong>a</strong> <b>b</b> <em>c</em> <i>d</i> <u>e</u> <s>f</s> <del>g</del></p>"),
    ).toBe("<p><strong>a</strong> <b>b</b> <em>c</em> <i>d</i> <u>e</u> <s>f</s> <del>g</del></p>");
    expect(html("<h1>T</h1><h6>t</h6><hr><p>x<br>y<sub>1</sub><sup>2</sup></p>")).toBe(
      "<h1>T</h1><h6>t</h6><hr><p>x<br>y<sub>1</sub><sup>2</sup></p>",
    );
    expect(html("<pre><code>a &lt; b</code></pre><blockquote>q</blockquote>")).toBe(
      "<pre><code>a &lt; b</code></pre><blockquote>q</blockquote>",
    );
    expect(html("<ul><li>a</li></ul><ol><li>b</li></ol><span>s</span>")).toBe(
      "<ul><li>a</li></ul><ol><li>b</li></ol><span>s</span>",
    );
  });

  test("tables keep colspan/rowspan only", () => {
    expect(
      html(
        '<table class="x"><thead><tr><th colspan="2" style="c">h</th></tr></thead><tbody><tr><td rowspan="3" id="i">d</td><td colspan="x">e</td></tr></tbody></table>',
      ),
    ).toBe(
      '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="3">d</td><td>e</td></tr></tbody></table>',
    );
  });

  test("other elements are removed and their text kept", () => {
    expect(html("<div><font>a</font><article>b</article></div>")).toBe("ab");
    expect(html('<form action="/x"><input value="v">label</form>')).toBe("label");
    expect(html("<svg><circle/>t</svg>")).toBe("t");
  });

  test("script, style, iframe, object, embed, template and noscript go with their contents", () => {
    expect(
      html(
        "a<script>alert(1)</script><style>p{}</style><iframe>i</iframe><object>o</object><embed><template>t</template><noscript>n</noscript>b",
      ),
    ).toBe("ab");
  });

  test("comments are dropped", () => {
    expect(html("a<!-- secret -->b")).toBe("ab");
  });

  test("every attribute but the allowed ones is dropped", () => {
    expect(html('<p style="x" class="c" id="i" onclick="alert(1)">t</p>')).toBe("<p>t</p>");
  });

  test("text is text: entity-decoded, never markup", () => {
    expect(html("&lt;script&gt;x&lt;/script&gt;")).toBe("&lt;script&gt;x&lt;/script&gt;");
  });

  test("mentions in text, not inside code or links", () => {
    expect(html("<p>hi @bob</p><code>@bob</code>")).toBe(
      `<p>hi <mention actor="bob@${DOMAIN}">@bob</mention></p><code>@bob</code>`,
    );
  });
});

describe("html sanitizer — links and images", () => {
  test("a keeps href only, through the link allow-list", () => {
    expect(html('<a href="https://e.com" target="_top" onclick="x">s</a>')).toBe(
      '<a href="https://e.com/">s</a>',
    );
    expect(html('<a href="mailto:a@e.com">m</a>')).toBe('<a href="mailto:a@e.com">m</a>');
    expect(html('<a href="javascript:alert(1)">x</a>')).toBe("x");
    expect(html('<a href="/rel">x</a><a href="#f">y</a><a>z</a>')).toBe("xyz");
    expect(html('<a href="attachment:att_1">file</a>')).toBe(
      '<att-link id="att_1">file</att-link>',
    );
  });

  test("img with data-attachment places the attachment; src is always dropped", () => {
    expect(html('<img data-attachment="att_2" alt="cap" src="https://tracker.e.com/p.gif">')).toBe(
      '<att id="att_2" caption="cap">',
    );
  });

  test("img without data-attachment loads nothing: only its alt text remains", () => {
    expect(html('<img src="https://tracker.e.com/p.gif" alt="pixel">')).toBe("pixel");
    expect(html('<img src="https://tracker.e.com/p.gif">')).toBe("");
  });

  test("referenced attachment ids", () => {
    const parsed = parseHtml('<img data-attachment="a1"><a href="attachment:a2">x</a>', DOMAIN);
    expect([...parsed.referencedAttachmentIds]).toEqual(["a1", "a2"]);
  });
});
