/**
 * Message body rendering per §5.3 / §5.8, in the real browser: dispatch on
 * `content.mime`, the `text/html` allow-list sanitizer, the link allow-list,
 * `attachment:` references, unreferenced attachments after the body, the
 * article title and cover rules, and untrusted attachments.
 *
 * The composer only produces `text/markdown` messages without article fields,
 * so the cases are placed straight into the render store through the
 * test-only hook (`__forumall_injectMessage`, see packages/web/src/main.tsx).
 */
import type { Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { expect, test } from "../harness/fixtures.ts";

/** One user, owning a public group with an open `general` channel. */
async function userInChannel(page: Page, baseUrl: string): Promise<string> {
  await registerUser(page, baseUrl, uniqueHandle());
  await page.goto("/groups");
  await page.getByTestId("open-create-group").click();
  await page.getByTestId("group-name").fill(`Render ${Date.now().toString(36)}`);
  await page.getByTestId("group-tier").selectOption("public");
  await page.getByTestId("create-group-submit").click();
  await page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await page.getByTestId("open-create-channel").click();
  await page.getByTestId("channel-name").fill("general");
  await page.getByTestId("channel-tier").selectOption("public");
  await page.getByTestId("create-channel-submit").click();
  const row = page.locator('[data-testid="channel-row"][data-channel-name="general"]');
  await row.getByTestId("open-channel").click();
  const chat = page.getByTestId("chat-view");
  await chat.waitFor({ state: "visible", timeout: 10_000 });
  const channelId = await chat.getAttribute("data-channel-id");
  if (!channelId) throw new Error("chat view missing data-channel-id");
  return channelId;
}

/** Place messages in the channel's timeline through the test-only hook. */
async function inject(page: Page, channelId: string, messages: unknown[]): Promise<void> {
  await page.evaluate(
    ([cid, list]) => {
      const hook = (
        globalThis as unknown as {
          __forumall_injectMessage: (channelId: string, message: unknown) => void;
        }
      ).__forumall_injectMessage;
      for (const m of list as unknown[]) hook(cid as string, m);
    },
    [channelId, messages] as const,
  );
}

const row = (page: Page, id: string) =>
  page.locator(`[data-testid="message-row"][data-message-id="${id}"]`);

const base = (id: string, seq: number) => ({
  id,
  author: "system@local",
  createdAt: new Date().toISOString(),
  cursor: `zzzzzzzz_${seq}`,
  metadata: [],
});

test("bodies render by content.mime; text/html only through the allow-list", async ({
  page,
  appServer,
}) => {
  const channelId = await userInChannel(page, appServer.baseUrl);
  await inject(page, channelId, [
    {
      ...base("plain_1", 1),
      type: "message",
      content: { mime: "text/plain", text: "**not bold** <b>tag</b> [x](https://example.com)" },
      attachments: [],
    },
    {
      ...base("html_1", 2),
      type: "message",
      content: {
        mime: "text/html",
        text:
          '<p class="c" onclick="window.__pwned=1">ok <b>bold</b></p>' +
          "<script>window.__pwned=1</script><style>body{display:none}</style>" +
          '<img src="https://tracker.invalid/p.gif" alt="pixel">' +
          '<a href="javascript:window.__pwned=1">bad</a> <a href="/rel">rel</a> ' +
          '<a href="https://example.com/ok">good</a> <iframe src="https://example.com"></iframe>',
      },
      attachments: [],
    },
    {
      ...base("unknown_1", 3),
      type: "message",
      content: { mime: "application/x-future", text: "<b>raw</b>" },
      attachments: [],
    },
  ]);

  // text/plain: shown as is.
  const plain = row(page, "plain_1").getByTestId("message-text");
  await expect(plain).toHaveText("**not bold** <b>tag</b> [x](https://example.com)");
  await expect(plain.locator("strong, b, a")).toHaveCount(0);

  // text/html: allowed elements kept, everything else gone, links allow-listed.
  const html = row(page, "html_1").getByTestId("message-text");
  await expect(html.locator("b")).toHaveText("bold");
  await expect(html.locator("p")).not.toHaveAttribute("class", /./);
  await expect(html.locator("script, style, iframe, img")).toHaveCount(0);
  await expect(html).toContainText("pixel");
  await expect(html.locator("a")).toHaveCount(1);
  await expect(html.locator("a")).toHaveAttribute("href", "https://example.com/ok");
  await html.locator("p").click();
  expect(await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned)).toBeUndefined();

  // An unsupported mime is shown as text.
  await expect(row(page, "unknown_1").getByTestId("message-text")).toHaveText("<b>raw</b>");
});

test("attachment: references resolve to the message's own attachments; the rest follow the body", async ({
  page,
  appServer,
}) => {
  const channelId = await userInChannel(page, appServer.baseUrl);
  const url = (name: string) => `${appServer.baseUrl}/no-such-media/${name}`;
  await inject(page, channelId, [
    {
      ...base("refs_1", 1),
      type: "message",
      content: {
        mime: "text/markdown",
        text:
          "![inline cap](attachment:a1) [the doc](attachment:a2) " +
          "![gone](attachment:zz) [gone link](attachment:zz) ![remote](https://example.com/r.png)",
      },
      attachments: [
        { id: "a1", mime: "image/png", url: url("a1.png"), size: 1, filename: "a1.png" },
        { id: "a2", mime: "text/html", url: url("a2.html"), size: 1, filename: "a2.html" },
        { id: "a3", mime: "image/svg+xml", url: url("a3.svg"), size: 1, filename: "a3.svg" },
        {
          id: "a4",
          mime: "text/html",
          url: "data:text/html,<script>window.__pwned=1</script>",
          size: 1,
          filename: "a4.html",
        },
      ],
    },
  ]);
  const message = row(page, "refs_1");
  const text = message.getByTestId("message-text");

  // The referenced image is shown where the body places it.
  await expect(text.getByTestId("body-attachment").getByTestId("attachment-image")).toHaveAttribute(
    "src",
    url("a1.png"),
  );
  // A link reference links the attachment's own URL, as a plain top-level link.
  await expect(text.getByTestId("body-attachment-link")).toHaveAttribute("href", url("a2.html"));
  // An id the message lacks is its caption / link text only; nothing fetched.
  await expect(text).toContainText("gone");
  await expect(text).toContainText("gone link");
  // A body-named remote image is a link, never loaded.
  await expect(text.getByTestId("body-remote-image")).toHaveAttribute(
    "href",
    "https://example.com/r.png",
  );
  await expect(page.locator('img[src="https://example.com/r.png"]')).toHaveCount(0);

  // Only the unreferenced attachments follow the body, in attachments order.
  const trailing = message.getByTestId("attachments");
  await expect(trailing.getByTestId("attachment-image")).toHaveCount(1);
  await expect(trailing.getByTestId("attachment-image")).toHaveAttribute("src", url("a3.svg"));
  // An untrusted data: URL is never used: a label, no link, no load.
  await expect(trailing.getByTestId("attachment-unavailable")).toHaveText(/a4\.html/);
  await expect(trailing.locator("a, img")).toHaveCount(1);

  // §5.8: no file is ever shown from the client's own origin or framed.
  await expect(
    page.locator(
      'iframe, object, embed, [srcdoc], [src^="blob:"], [src^="data:"], [href^="blob:"], [href^="data:"]',
    ),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("article title and cover: title field, else a leading level-1 heading, else untitled", async ({
  page,
  appServer,
}) => {
  const channelId = await userInChannel(page, appServer.baseUrl);
  const url = (name: string) => `${appServer.baseUrl}/no-such-media/${name}`;
  const img = (id: string) => ({ id, mime: "image/png", url: url(`${id}.png`), size: 1 });
  await inject(page, channelId, [
    {
      ...base("art_setext", 1),
      type: "article",
      cover: "c1",
      content: {
        mime: "text/markdown",
        text: "Setext Title\n============\n\nbody text ![in body](attachment:b1)",
      },
      attachments: [img("c1"), img("b1"), img("t1")],
    },
    {
      ...base("art_field", 2),
      type: "article",
      title: "Field Title",
      content: { mime: "text/markdown", text: "# Body Heading\n\nmore" },
      attachments: [],
    },
    {
      ...base("art_untitled", 3),
      type: "article",
      content: { mime: "text/markdown", text: "intro paragraph\n\n# Later Heading" },
      attachments: [],
    },
  ]);

  // Stream cards.
  await expect(row(page, "art_setext").getByTestId("open-article")).toHaveText("Setext Title");
  await expect(row(page, "art_setext").getByTestId("article-cover")).toBeVisible();
  await expect(row(page, "art_field").getByTestId("open-article")).toHaveText("Field Title");
  await expect(row(page, "art_untitled").getByTestId("open-article")).toHaveText(
    "Untitled article",
  );

  // Reading pane: cover, title, body without the title heading, inline
  // attachment in the body, the unreferenced one after it (not the cover).
  await row(page, "art_setext").getByTestId("open-article").click();
  const reading = page.getByTestId("article-reading");
  await expect(reading.getByTestId("article-title")).toHaveText("Setext Title");
  await expect(
    reading.getByTestId("article-cover").getByTestId("attachment-image"),
  ).toHaveAttribute("src", url("c1.png"));
  const body = reading.getByTestId("article-body");
  await expect(body.locator("h1")).toHaveCount(0);
  await expect(body.getByTestId("attachment-image")).toHaveAttribute("src", url("b1.png"));
  const after = reading.getByTestId("article-attachments").getByTestId("attachment-image");
  await expect(after).toHaveCount(1);
  await expect(after).toHaveAttribute("src", url("t1.png"));
  await reading.getByTestId("article-back").click();

  // With a title field, the body's own heading stays in the body.
  await row(page, "art_field").getByTestId("open-article").click();
  await expect(reading.getByTestId("article-title")).toHaveText("Field Title");
  await expect(reading.getByTestId("article-body").locator("h1")).toHaveText("Body Heading");
  await reading.getByTestId("article-back").click();

  // A level-1 heading that is not the first block is not a title.
  await row(page, "art_untitled").getByTestId("open-article").click();
  await expect(reading.getByTestId("article-title")).toHaveText("Untitled article");
  await expect(reading.getByTestId("article-body").locator("h1")).toHaveText("Later Heading");
});
