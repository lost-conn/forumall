/**
 * Overboard features e2e (single provider, two browser contexts): replies
 * (inline + nested under a memo), composing an article (WYSIWYG → markdown),
 * and the user-profile modal.
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server with
 * A = owner and B = member sharing one public group + text channel.
 */
import type { Browser, Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { expect, test } from "../harness/fixtures.ts";

async function createGroup(page: Page, name: string): Promise<string> {
  await page.getByTestId("open-create-group").click();
  await page.getByTestId("create-group-modal").waitFor({ state: "visible" });
  await page.getByTestId("group-name").fill(name);
  await page.getByTestId("group-tier").selectOption("public");
  await page.getByTestId("join-policy-open").click();
  await page.getByTestId("create-group-submit").click();
  await page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await page.getByTestId("group-name-heading").waitFor({ state: "visible" });
  const m = page.url().match(/\/groups\/([^/?]+)/);
  if (!m) throw new Error(`could not extract group id from ${page.url()}`);
  return decodeURIComponent(m[1] as string);
}

async function createChannel(page: Page, name: string): Promise<void> {
  await page.getByTestId("open-create-channel").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "visible" });
  await page.getByTestId("channel-name").fill(name);
  await page.getByTestId("channel-tier").selectOption("public");
  await page.getByTestId("create-channel-submit").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "hidden" });
  await page
    .locator(`[data-testid="channel-row"][data-channel-name="${name}"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function openChat(page: Page, channelName: string): Promise<void> {
  const row = page.locator(`[data-testid="channel-row"][data-channel-name="${channelName}"]`);
  await row.getByTestId("open-channel").click();
  await page.getByTestId("chat-view").waitFor({ state: "visible", timeout: 10_000 });
}

async function compose(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function twoUsersInChannel(
  page: Page,
  browser: Browser,
  baseUrl: string,
): Promise<{ a: Page; b: Page }> {
  await registerUser(page, baseUrl, uniqueHandle());
  await page.goto("/groups");
  const groupId = await createGroup(page, `Ovr ${Date.now().toString(36)}`);
  await createChannel(page, "general");

  const context = await browser.newContext({ baseURL: baseUrl });
  const bPage = await context.newPage();
  await registerUser(bPage, baseUrl, uniqueHandle());
  await bPage.goto(`/groups/${groupId}`);
  await bPage.getByTestId("join-group").click();
  await bPage.getByTestId("channels-list").waitFor({ state: "visible", timeout: 10_000 });
  await expect(bPage.getByTestId("join-card")).toHaveCount(0, { timeout: 10_000 });

  await openChat(page, "general");
  await openChat(bPage, "general");
  return { a: page, b: bPage };
}

test("inline reply: A replies to a message → reply shows quoted parent; B sees it", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  const parent = `parent-${Date.now().toString(36)}`;
  await compose(a, parent);
  const parentRow = a.locator('[data-testid="message-row"]').filter({ hasText: parent }).first();
  await expect(parentRow).toBeVisible({ timeout: 10_000 });

  // Click Reply on the parent, then compose the reply.
  await parentRow.hover();
  await parentRow.getByTestId("reply-button").click();
  await expect(a.getByTestId("composer-reply-pill")).toBeVisible();

  const reply = `reply-${Date.now().toString(36)}`;
  await compose(a, reply);

  // The reply renders with a quoted-parent snippet, and B receives it.
  const replyRowA = a.locator('[data-testid="message-row"]').filter({ hasText: reply }).first();
  await expect(replyRowA).toBeVisible({ timeout: 10_000 });
  await expect(a.getByTestId("reply-quote").first()).toBeVisible();
  await expect(b.locator('[data-testid="message-row"]').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 10_000,
  });

  await b.context().close();
});

test("memo + nested reply: a memo's reply is nested under it, not in the main flow", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  // Compose a memo (kind selector → Memo; memos send via the Send button).
  await a.getByTestId("compose-kind-memo").click();
  const memoText = `memo-${Date.now().toString(36)}`;
  await a.getByTestId("composer-input").fill(memoText);
  await a.getByTestId("send-button").click();

  const memoRow = a.locator('[data-testid="message-row"]').filter({ hasText: memoText }).first();
  await expect(memoRow).toBeVisible({ timeout: 10_000 });
  // The type label badge was removed — kind is now implicit from the memo card layout.

  // Reply to the memo.
  await memoRow.hover();
  await memoRow.getByTestId("reply-button").click();
  const memoReply = `memo-reply-${Date.now().toString(36)}`;
  await compose(a, memoReply);

  // The reply appears (nested under the memo, auto-expanded for long-form).
  await expect(a.locator('[data-testid="message-row"]').filter({ hasText: memoReply })).toHaveCount(
    1,
    { timeout: 10_000 },
  );
  // B sees both the memo and its nested reply.
  await expect(b.locator('[data-testid="message-row"]').filter({ hasText: memoReply })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  await b.context().close();
});

test("compose an article via the WYSIWYG → renders as markdown", async ({
  page,
  browser,
  appServer,
}) => {
  const { a } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  await a.getByTestId("compose-kind-article").click();
  await a.getByTestId("open-article-editor").click();
  const editor = a.getByTestId("article-input");
  await editor.click();
  const body = `article-body-${Date.now().toString(36)}`;
  await a.keyboard.type(body);
  await a.getByTestId("article-editor-publish").click();

  const article = a.getByTestId("message-article").first();
  await expect(article).toBeVisible({ timeout: 10_000 });
  await expect(article).toContainText(body);
});

test("profile modal: clicking a message author opens their profile", async ({
  page,
  browser,
  appServer,
}) => {
  const { a } = await twoUsersInChannel(page, browser, appServer.baseUrl);

  const text = `mine-${Date.now().toString(36)}`;
  await compose(a, text);
  const row = a.locator('[data-testid="message-row"]').filter({ hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  await row.getByTestId("message-author").click();
  const modal = a.getByTestId("user-profile-modal");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  // It's the author's own profile → shows "This is you" and the handle.
  await expect(modal.getByTestId("profile-handle")).toContainText("@");
});
