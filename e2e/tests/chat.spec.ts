/**
 * P8 chat UI e2e (single provider, two browser contexts).
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server and
 * exercises the §7.1 (live messaging / reactions / typing / edit / delete over
 * WS), §7.2 (history paging) and §5.8 (media) chat experience across TWO users
 * (A = owner, B = member) sharing one public group + text channel:
 *
 *  1. A posts → B sees it live; A's optimistic echo is replaced by the canonical
 *     message (exactly one copy, server id).
 *  2. A reacts → B sees the count/emoji; A removes it → B sees it gone.
 *  3. A types → B sees a typing indicator; it clears.
 *  4. A edits → B sees the edited content; A deletes → B sees the tombstone
 *     (position preserved).
 *  5. an `article`-type message renders as markdown; a fabricated unknown-`type`
 *     message renders via the generic text fallback (no crash).
 *  6. attachment: A uploads a small image → it appears for both.
 */
import type { Browser, Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { expect, test } from "../harness/fixtures.ts";

/** Open the create-group form, fill it, submit, and return the new group id. */
async function createGroup(
  page: Page,
  opts: { name: string; tier?: string; joinPolicy?: "open" | "request" | "invite" },
): Promise<string> {
  await page.getByTestId("open-create-group").click();
  await page.getByTestId("create-group-modal").waitFor({ state: "visible" });
  await page.getByTestId("group-name").fill(opts.name);
  if (opts.tier) await page.getByTestId("group-tier").selectOption(opts.tier);
  if (opts.joinPolicy) await page.getByTestId(`join-policy-${opts.joinPolicy}`).click();
  await page.getByTestId("create-group-submit").click();
  await page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await page.getByTestId("group-name-heading").waitFor({ state: "visible" });
  const m = page.url().match(/\/groups\/([^/?]+)/);
  if (!m) throw new Error(`could not extract group id from ${page.url()}`);
  return decodeURIComponent(m[1] as string);
}

/** Create a text channel in the currently-open group view. */
async function createChannel(page: Page, name: string, tier = "public"): Promise<void> {
  await page.getByTestId("open-create-channel").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "visible" });
  await page.getByTestId("channel-name").fill(name);
  await page.getByTestId("channel-tier").selectOption(tier);
  await page.getByTestId("create-channel-submit").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "hidden" });
  await page
    .locator(`[data-testid="channel-row"][data-channel-name="${name}"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
}

/** Register a fresh user in a brand-new browser context; returns its page + actor. */
async function newUser(
  browser: Browser,
  baseUrl: string,
): Promise<{ page: Page; actor: string; handle: string }> {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  const { handle, actor } = await registerUser(page, baseUrl, uniqueHandle());
  return { page, actor, handle };
}

/** Open the chat for a named text channel in the currently-open group view. */
async function openChat(page: Page, channelName: string): Promise<string> {
  const row = page.locator(`[data-testid="channel-row"][data-channel-name="${channelName}"]`);
  await row.getByTestId("open-channel").click();
  const chat = page.getByTestId("chat-view");
  await chat.waitFor({ state: "visible", timeout: 10_000 });
  const channelId = await chat.getAttribute("data-channel-id");
  if (!channelId) throw new Error("chat view missing data-channel-id");
  return channelId;
}

/** Send a message via the composer (Enter-to-send). */
async function compose(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/**
 * Set up A (owner) + B (member) in one public group + text channel, both with the
 * chat open. Returns the two pages, the channel id, and B's actor.
 */
async function twoUsersInChannel(
  page: Page,
  browser: Browser,
  baseUrl: string,
): Promise<{ a: Page; b: Page; bUser: { actor: string }; channelId: string; groupId: string }> {
  await registerUser(page, baseUrl, uniqueHandle());
  await page.goto("/groups");
  const groupId = await createGroup(page, {
    name: `Chat ${Date.now().toString(36)}`,
    tier: "public",
    joinPolicy: "open",
  });
  await createChannel(page, "general", "public");

  // B joins the open public group, then opens the same channel.
  const b = await newUser(browser, baseUrl);
  await b.page.goto(`/groups/${groupId}`);
  await b.page.getByTestId("join-group").click();
  // Wait until B is a member (the join card disappears / channels become postable).
  await b.page.getByTestId("channels-list").waitFor({ state: "visible", timeout: 10_000 });
  await expect(b.page.getByTestId("join-card")).toHaveCount(0, { timeout: 10_000 });

  const channelId = await openChat(page, "general");
  await openChat(b.page, "general");

  return { a: page, b: b.page, bUser: { actor: b.actor }, channelId, groupId };
}

test("A posts → B sees it live; optimistic echo reconciles to one canonical copy", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  const text = `hello-${Date.now().toString(36)}`;
  await compose(a, text);

  // A: exactly ONE copy, and it carries a server id (not the optimistic id).
  const aRows = a.locator('[data-testid="message-row"]').filter({ hasText: text });
  await expect(aRows).toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(async () => aRows.first().getAttribute("data-message-id"))
    .not.toMatch(/^optimistic:/);
  // The pending marker clears once reconciled.
  await expect(aRows.first().getByTestId("message-pending")).toHaveCount(0);

  // B sees it live, exactly once.
  const bRows = b.locator('[data-testid="message-row"]').filter({ hasText: text });
  await expect(bRows).toHaveCount(1, { timeout: 10_000 });

  await b.context().close();
});

test("reactions: A reacts → B sees it; A removes → B sees it gone", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  const text = `react-${Date.now().toString(36)}`;
  await compose(a, text);
  const aRow = a.locator('[data-testid="message-row"]').filter({ hasText: text }).first();
  await expect(aRow).toBeVisible({ timeout: 10_000 });

  // A reacts 👍 via the picker.
  await aRow.getByTestId("react-button").click();
  await a.getByTestId("reaction-picker").waitFor({ state: "visible" });
  await a.locator('[data-testid="reaction-pick"][data-reaction-key="+1"]').click();

  // B sees the reaction chip with count 1.
  const bRow = b.locator('[data-testid="message-row"]').filter({ hasText: text }).first();
  const bChip = bRow.locator('[data-testid="reaction-chip"][data-reaction-key="+1"]');
  await expect(bChip).toBeVisible({ timeout: 10_000 });
  await expect(bChip.getByTestId("reaction-count")).toHaveText("1");

  // A removes it (toggle the existing chip on A's side).
  await aRow.locator('[data-testid="reaction-chip"][data-reaction-key="+1"]').click();

  // B sees it gone.
  await expect(bChip).toHaveCount(0, { timeout: 10_000 });

  await b.context().close();
});

test("typing: A typing → B sees an indicator; it clears", async ({ page, browser, appServer }) => {
  const { a, b, bUser } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  // A starts typing (without sending).
  const input = a.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("draft message…", { delay: 20 });

  // B sees a typing indicator naming A.
  const indicator = b.getByTestId("typing-indicator");
  await expect(indicator).toBeVisible({ timeout: 10_000 });
  await expect(indicator).toContainText("typing");

  // A blurs (stop) → the indicator clears on B.
  await input.evaluate((el: HTMLElement) => el.blur());
  await expect(b.getByTestId("typing-indicator")).toHaveCount(0, { timeout: 10_000 });

  void bUser;
  await b.context().close();
});

test("edit + delete: B sees the edit, then the tombstone (position preserved)", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  // Post two messages so we can assert position is preserved after a delete.
  const first = `first-${Date.now().toString(36)}`;
  const second = `second-${Date.now().toString(36)}`;
  await compose(a, first);
  await compose(a, second);
  await expect(b.locator('[data-testid="message-row"]').filter({ hasText: second })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  // Resolve the first message's canonical id (the optimistic echo has reconciled
  // by the time B sees `second`). We key the edit/delete on the STABLE row id —
  // a `hasText` filter would stop matching once the body becomes an edit textarea.
  const aFirst = a.locator('[data-testid="message-row"]').filter({ hasText: first }).first();
  await expect(aFirst).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => aFirst.getAttribute("data-message-id")).not.toMatch(/^optimistic:/);
  const firstId = await aFirst.getAttribute("data-message-id");
  const aFirstById = a.locator(`[data-testid="message-row"][data-message-id="${firstId}"]`);

  // A edits the FIRST message.
  await aFirstById.hover();
  await aFirstById.getByTestId("edit-message").click();
  const edited = `${first}-edited`;
  await aFirstById.getByTestId("edit-input").fill(edited);
  await aFirstById.getByTestId("save-edit").click();

  // B sees the edited content + the (edited) marker.
  const bFirst = b.locator(`[data-testid="message-row"][data-message-id="${firstId}"]`);
  await expect(bFirst).toContainText(edited, { timeout: 10_000 });
  await expect(bFirst.getByTestId("message-edited")).toBeVisible();

  // A deletes the first message.
  a.once("dialog", (d) => void d.accept());
  await aFirstById.hover();
  await aFirstById.getByTestId("delete-message").click();

  // B sees the tombstone IN PLACE (same row id), and it's still ABOVE the second
  // message in DOM order (position preserved).
  const bRows = b.locator('[data-testid="message-row"]');
  await expect(bFirst.getByTestId("message-tombstone")).toBeVisible({ timeout: 10_000 });
  await expect(bRows.filter({ hasText: second })).toHaveCount(1);
  const tombIndex = await bFirst.evaluate((el) => {
    const all = [...document.querySelectorAll('[data-testid="message-row"]')];
    return all.indexOf(el);
  });
  const secondIndex = await bRows
    .filter({ hasText: second })
    .first()
    .evaluate((el) => {
      const all = [...document.querySelectorAll('[data-testid="message-row"]')];
      return all.indexOf(el);
    });
  expect(tombIndex).toBeLessThan(secondIndex);

  await b.context().close();
});

test("article renders as markdown; an unknown type falls back to text (no crash)", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, channelId } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  // The product can only compose `message`-type messages, so fabricate the
  // `article` + unknown-type variants directly in the render store via the
  // test-only hook (see main.tsx) and assert §5.3/§2.3 rendering.
  await a.evaluate(
    ([cid]) => {
      const inject = (
        globalThis as unknown as {
          __forumall_injectMessage: (channelId: string, message: unknown) => void;
        }
      ).__forumall_injectMessage;
      inject(cid as string, {
        id: "art_1",
        author: "system@local",
        type: "article",
        content: {
          mime: "text/markdown",
          text: "# Heading\n\n**bold** and a [link](https://example.com)",
        },
        createdAt: new Date().toISOString(),
        cursor: "zzzzzzzz_article",
      });
      inject(cid as string, {
        id: "weird_1",
        author: "system@local",
        type: "holographic-future-type",
        content: { mime: "text/plain", text: "fallback-body-xyz" },
        createdAt: new Date().toISOString(),
        cursor: "zzzzzzzz_weird",
      });
    },
    [channelId],
  );

  // Article → markdown (a real <h1> + <strong> + sanitized <a>).
  const article = a.getByTestId("message-article").first();
  await expect(article).toBeVisible({ timeout: 10_000 });
  await expect(article.locator("h1")).toHaveText("Heading");
  await expect(article.locator("strong")).toHaveText("bold");
  await expect(article.locator('a[href="https://example.com"]')).toBeVisible();

  // Unknown type → generic text fallback, body intact, no crash (the article
  // above still rendered, so the app didn't throw on the unknown type).
  await expect(a.locator('[data-testid="message-row"][data-message-id="weird_1"]')).toContainText(
    "fallback-body-xyz",
  );
});

test("attachment upload: A attaches a small image → it appears for both", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  // A 1x1 transparent PNG.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const buffer = Buffer.from(pngBase64, "base64");

  await a.getByTestId("file-input").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer,
  });
  // The pending attachment chip shows, then send.
  await expect(a.getByTestId("composer-attachments")).toBeVisible({ timeout: 10_000 });
  await compose(a, "look at this");

  // The image attachment appears for A and B (inline <img>).
  const aImg = a.getByTestId("attachment-image").first();
  await expect(aImg).toBeVisible({ timeout: 10_000 });
  const bImg = b.getByTestId("attachment-image").first();
  await expect(bImg).toBeVisible({ timeout: 10_000 });
  // The image actually loaded (naturalWidth > 0).
  await expect
    .poll(() => aImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  await b.context().close();
});
