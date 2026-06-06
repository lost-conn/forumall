/**
 * P8 home feed (follows) + discovery/browse e2e.
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server and
 * exercises §7.6 (follows + the CLIENT-COMPOSED home feed) and §11.2 (the
 * discover feed):
 *
 *  1. Home feed merges two followed channels: a user creates two channels (in two
 *     groups), posts in each, follows both → Home shows BOTH, newest-first.
 *  2. Live: a new message posted to a followed channel (by a second user) appears
 *     live in the feed; an edit / delete is reflected (edited content / tombstone).
 *  3. Unfollow → the channel's messages drop out of the feed.
 *  4. Discover (feature ON via the harness env): a `discoverable` channel with a
 *     message is listed as a pointer; a non-discoverable channel is absent.
 *  5. Discover (feature default-OFF): the endpoint 404s → the graceful "not
 *     offered" state is shown.
 *
 * The discover scenarios boot a DEDICATED server (one with `ENABLE_DISCOVER_FEED=
 * true`, one default-off) via `bootServer(extraEnv)`, since the feature is a
 * server-wide config toggle.
 */
import type { Browser, Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { type BootedServer, bootServer, expect, test } from "../harness/fixtures.ts";

/** Open the create-group form, fill it, submit, and return the new group id. */
async function createGroup(
  page: Page,
  opts: { name: string; tier?: string; joinPolicy?: "open" | "request" | "invite" },
): Promise<string> {
  await page.goto("/groups");
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

/** Send a message via the composer (Enter-to-send) and wait for it to land. */
async function compose(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await expect(page.locator('[data-testid="message-row"]').filter({ hasText: text })).toHaveCount(
    1,
    { timeout: 10_000 },
  );
}

/** Click the chat header Follow toggle and wait until it reflects "Following". */
async function follow(page: Page): Promise<void> {
  const toggle = page.getByTestId("follow-toggle");
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  if ((await toggle.getAttribute("data-following")) !== "1") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("data-following", "1", { timeout: 10_000 });
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

test("home feed merges two followed channels, newest-first", async ({ page, appServer }) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());

  // Two groups, one channel each, a message in each (alpha older, beta newer).
  await createGroup(page, { name: `G1 ${Date.now().toString(36)}`, tier: "public" });
  await createChannel(page, "alpha", "public");
  await openChat(page, "alpha");
  const alphaText = `alpha-${Date.now().toString(36)}`;
  await compose(page, alphaText);
  await follow(page);

  await createGroup(page, { name: `G2 ${Date.now().toString(36)}`, tier: "public" });
  await createChannel(page, "beta", "public");
  await openChat(page, "beta");
  const betaText = `beta-${Date.now().toString(36)}`;
  await compose(page, betaText);
  await follow(page);

  // Home composes the merged feed from both follows.
  await page.goto("/");
  await page.getByTestId("home-feed").waitFor({ state: "visible" });
  const items = page.locator('[data-testid="feed-item"]');

  await expect(items.filter({ hasText: alphaText })).toHaveCount(1, { timeout: 15_000 });
  await expect(items.filter({ hasText: betaText })).toHaveCount(1, { timeout: 15_000 });

  // beta was posted last → it sorts above alpha (newest-first).
  const betaIdx = await items
    .filter({ hasText: betaText })
    .first()
    .evaluate((el) => [...document.querySelectorAll('[data-testid="feed-item"]')].indexOf(el));
  const alphaIdx = await items
    .filter({ hasText: alphaText })
    .first()
    .evaluate((el) => [...document.querySelectorAll('[data-testid="feed-item"]')].indexOf(el));
  expect(betaIdx).toBeLessThan(alphaIdx);
});

test("feed reflects a live message, an edit, and a delete on a followed channel", async ({
  page,
  browser,
  appServer,
}) => {
  // A owns a public group + channel, posts, and follows it.
  const a = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const groupId = await createGroup(page, {
    name: `Live ${Date.now().toString(36)}`,
    tier: "public",
    joinPolicy: "open",
  });
  await createChannel(page, "general", "public");
  await openChat(page, "general");
  await follow(page);
  void a;

  // B joins the open group + opens the same channel to post / edit / delete.
  const b = await newUser(browser, appServer.baseUrl);
  await b.page.goto(`/groups/${groupId}`);
  await b.page.getByTestId("join-group").click();
  await expect(b.page.getByTestId("join-card")).toHaveCount(0, { timeout: 10_000 });
  await openChat(b.page, "general");

  // A watches the home feed.
  await page.goto("/");
  await page.getByTestId("home-feed").waitFor({ state: "visible" });

  // B posts → appears live in A's feed.
  const liveText = `live-${Date.now().toString(36)}`;
  await compose(b.page, liveText);
  const feedRow = page.locator('[data-testid="feed-item"]').filter({ hasText: liveText });
  await expect(feedRow).toHaveCount(1, { timeout: 15_000 });

  // Resolve the message's canonical id on B's side so we can edit/delete it.
  const bRow = b.page.locator('[data-testid="message-row"]').filter({ hasText: liveText }).first();
  await expect.poll(() => bRow.getAttribute("data-message-id")).not.toMatch(/^optimistic:/);
  const msgId = await bRow.getAttribute("data-message-id");
  const bById = b.page.locator(`[data-testid="message-row"][data-message-id="${msgId}"]`);

  // B edits → A's feed shows the edited content + (edited) marker.
  await bById.hover();
  await bById.getByTestId("edit-message").click();
  const edited = `${liveText}-edited`;
  await bById.getByTestId("edit-input").fill(edited);
  await bById.getByTestId("save-edit").click();
  const editedRow = page.locator('[data-testid="feed-item"]').filter({ hasText: edited });
  await expect(editedRow).toHaveCount(1, { timeout: 15_000 });
  await expect(editedRow.first().getByTestId("feed-item-edited")).toBeVisible();

  // B deletes → A's feed shows the tombstone in place.
  b.page.once("dialog", (d) => void d.accept());
  await bById.hover();
  await bById.getByTestId("delete-message").click();
  const feedItemById = page.locator(`[data-testid="feed-item"][data-message-id="${msgId}"]`);
  await expect(feedItemById.getByTestId("feed-item-tombstone")).toBeVisible({ timeout: 15_000 });

  await b.page.context().close();
});

test("unfollowing a channel drops its messages from the feed", async ({ page, appServer }) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());

  // Two followed channels.
  await createGroup(page, { name: `U1 ${Date.now().toString(36)}`, tier: "public" });
  await createChannel(page, "keep", "public");
  await openChat(page, "keep");
  const keepText = `keep-${Date.now().toString(36)}`;
  await compose(page, keepText);
  await follow(page);

  const dropGroupId = await createGroup(page, {
    name: `U2 ${Date.now().toString(36)}`,
    tier: "public",
  });
  await createChannel(page, "drop", "public");
  await openChat(page, "drop");
  const dropText = `drop-${Date.now().toString(36)}`;
  await compose(page, dropText);
  await follow(page);

  // Both present in the feed.
  await page.goto("/");
  await page.getByTestId("home-feed").waitFor({ state: "visible" });
  await expect(page.locator('[data-testid="feed-item"]').filter({ hasText: keepText })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid="feed-item"]').filter({ hasText: dropText })).toHaveCount(
    1,
    { timeout: 15_000 },
  );

  // Unfollow "drop" from its chat header (navigate back into its group first).
  await page.goto(`/groups/${dropGroupId}`);
  await page.getByTestId("group-name-heading").waitFor({ state: "visible" });
  await openChat(page, "drop");
  const toggle = page.getByTestId("follow-toggle");
  await expect(toggle).toHaveAttribute("data-following", "1", { timeout: 10_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-following", "0", { timeout: 10_000 });

  // Back on Home: "drop" is gone, "keep" remains.
  await page.goto("/");
  await page.getByTestId("home-feed").waitFor({ state: "visible" });
  await expect(page.locator('[data-testid="feed-item"]').filter({ hasText: keepText })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid="feed-item"]').filter({ hasText: dropText })).toHaveCount(
    0,
    { timeout: 15_000 },
  );
});

test("discover (feature ON): lists a discoverable channel pointer; hides a non-discoverable one", async ({
  browser,
}) => {
  // A dedicated server with the discover feed enabled.
  const server: BootedServer = await bootServer({ ENABLE_DISCOVER_FEED: "true" });
  try {
    const ctx = await browser.newContext({ baseURL: server.baseUrl });
    const page = await ctx.newPage();
    await registerUser(page, server.baseUrl, uniqueHandle());

    // A group with a discoverable channel (+ a message for the sample) and a
    // private channel that must NOT surface in discover.
    await createGroup(page, { name: `Disc ${Date.now().toString(36)}`, tier: "public" });
    const discName = `disc-${Date.now().toString(36)}`;
    await createChannel(page, discName, "discoverable");
    // Resolve both channel ids up front (the discover pointer shows the channel
    // id, not its name) while still in the group view.
    const discId = await openChat(page, discName);
    const sampleText = `sample-${Date.now().toString(36)}`;
    await compose(page, sampleText);

    const hiddenName = `hidden-${Date.now().toString(36)}`;
    await createChannel(page, hiddenName, "private");
    const privId = await openChat(page, hiddenName);

    // Discover lists the discoverable channel as a pointer; not the private one.
    await page.goto("/discover");
    await page.getByTestId("discover-page").waitFor({ state: "visible" });
    await expect(page.getByTestId("discover-list")).toBeVisible({ timeout: 15_000 });

    const discItem = page.locator(`[data-testid="discover-item"][data-channel="${discId}"]`);
    await expect(discItem).toHaveCount(1, { timeout: 15_000 });
    // Its non-authoritative sample preview renders.
    await expect(discItem.getByTestId("discover-sample")).toContainText(sampleText, {
      timeout: 15_000,
    });

    // The private channel id never appears as a discover pointer.
    await expect(
      page.locator(`[data-testid="discover-item"][data-channel="${privId}"]`),
    ).toHaveCount(0);

    // Follow the discovered channel from the browse list.
    await discItem.getByTestId("discover-follow").click();
    await expect(discItem.getByTestId("discover-follow")).toHaveText("Following", {
      timeout: 10_000,
    });

    await ctx.close();
  } finally {
    server.stop();
  }
});

test("discover (feature default-OFF): the endpoint 404s → graceful not-offered state", async ({
  page,
  appServer,
}) => {
  // The default appServer has the discover feed disabled.
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/discover");
  await page.getByTestId("discover-page").waitFor({ state: "visible" });
  await expect(page.getByTestId("discover-not-offered")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("discover-not-offered")).toContainText("not offered");
});
