/**
 * P8 groups & channels e2e (single provider, two browser contexts).
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server and
 * exercises the §5.5 (groups/channels), §5.7 (membership + join-requests), and
 * §5.6 (invites + guest redeem) UI:
 *
 *  1. create a group + a channel → both appear in the UI.
 *  2. a private channel is hidden from a non-member (second context) while a
 *     public one shows.
 *  3. invite flow: a manager mints an invite; a second signed-in user opens
 *     `/invite/{token}` and redeems → becomes a member.
 *  4. join-request flow: a `request`-policy group; a second user requests to
 *     join → the manager approves → the second user becomes a member.
 *  5. guest redeem: a `grantsGuest` invite opened by a brand-new browser (no
 *     account) provisions a guest and lands them in the group.
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

  // On success the page routes into /groups/{id}; read the id from the URL.
  await page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await page.getByTestId("group-name-heading").waitFor({ state: "visible" });
  const m = page.url().match(/\/groups\/([^/?]+)/);
  if (!m) throw new Error(`could not extract group id from ${page.url()}`);
  return decodeURIComponent(m[1] as string);
}

/** Create a channel in the currently-open group view. */
async function createChannel(
  page: Page,
  opts: { name: string; tier?: string; type?: "text" | "call" },
): Promise<void> {
  await page.getByTestId("open-create-channel").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "visible" });
  await page.getByTestId("channel-name").fill(opts.name);
  if (opts.type) await page.getByTestId(`channel-type-${opts.type}`).click();
  if (opts.tier) await page.getByTestId("channel-tier").selectOption(opts.tier);
  await page.getByTestId("create-channel-submit").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "hidden" });
  await page
    .locator(`[data-testid="channel-row"][data-channel-name="${opts.name}"]`)
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

test("create a group and a channel → both appear", async ({ page, appServer }) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/groups");

  const name = `Group ${Date.now().toString(36)}`;
  await createGroup(page, { name, tier: "public", joinPolicy: "open" });

  // The group shows in the left rail and its heading is visible.
  await expect(page.getByTestId("group-name-heading")).toHaveText(name);
  await expect(
    page.locator(`[data-testid="my-group-item"][data-group-name="${name}"]`),
  ).toBeVisible();

  await createChannel(page, { name: "general", tier: "public" });
  await expect(
    page.locator('[data-testid="channel-row"][data-channel-name="general"]'),
  ).toBeVisible();
});

test("a private channel is hidden from a non-member, a public one shows", async ({
  page,
  browser,
  appServer,
}) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/groups");

  // A public group so a non-member can read it + see its public channels.
  const groupId = await createGroup(page, {
    name: `Vis ${Date.now().toString(36)}`,
    tier: "public",
    joinPolicy: "open",
  });

  await createChannel(page, { name: "lobby", tier: "public" });
  await createChannel(page, { name: "secret", tier: "group" });

  // Change "secret" to the `private` tier via the manage modal.
  const secretRow = page.locator('[data-testid="channel-row"][data-channel-name="secret"]');
  await secretRow.getByTestId("manage-channel").click();
  await page.getByTestId("manage-channel-modal").waitFor({ state: "visible" });
  await page.getByTestId("manage-channel-tier").selectOption("private");
  await page.getByTestId("save-channel").click();
  await page.getByTestId("manage-channel-modal").waitFor({ state: "hidden" });

  // A second user (different context), NOT a member, opens the group.
  const b = await newUser(browser, appServer.baseUrl);
  await b.page.goto(`/groups/${groupId}`);
  await b.page.getByTestId("group-name-heading").waitFor({ state: "visible" });
  await b.page.getByTestId("channels-list").waitFor({ state: "visible" });

  // The non-member sees the public channel but NOT the private one.
  await expect(
    b.page.locator('[data-testid="channel-row"][data-channel-name="lobby"]'),
  ).toBeVisible();
  await expect(
    b.page.locator('[data-testid="channel-row"][data-channel-name="secret"]'),
  ).toHaveCount(0);

  await b.page.context().close();
});

test("invite flow: manager mints a link, a signed-in user redeems → member", async ({
  page,
  browser,
  appServer,
}) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/groups");

  // An invite-only group so membership comes solely from the redeem.
  const groupId = await createGroup(page, {
    name: `Inv ${Date.now().toString(36)}`,
    tier: "group",
    joinPolicy: "invite",
  });
  await createChannel(page, { name: "general", tier: "group" });

  // Manager mints an invite and grabs the shareable link.
  await page.getByTestId("space-menu-toggle").click();
  await page.getByTestId("tab-invites").click();
  await page.getByTestId("invite-role").fill("member");
  await page.getByTestId("create-invite").click();
  await page.getByTestId("invite-link").waitFor({ state: "visible" });
  const link = (await page.getByTestId("invite-link").textContent())?.trim();
  expect(link).toBeTruthy();
  const token = (link as string).split("/invite/")[1];
  expect(token).toBeTruthy();

  // A second signed-in user opens /invite/{token} → redeemed → routed into group.
  const b = await newUser(browser, appServer.baseUrl);
  await b.page.goto(`/invite/${token}`);
  await b.page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  expect(b.page.url()).toContain(`/groups/${groupId}`);

  // Now a member: the member list (members-only for a `group`-tier group) loads
  // and includes the second user.
  await b.page.getByTestId("space-menu-toggle").click();
  await b.page.getByTestId("tab-members").click();
  await b.page.getByTestId("members-list").waitFor({ state: "visible" });
  await expect(b.page.getByTestId("members-list")).toContainText(b.actor);

  await b.page.context().close();
});

test("join-request flow: request to join → manager approves → member", async ({
  page,
  browser,
  appServer,
}) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/groups");

  const groupId = await createGroup(page, {
    name: `Req ${Date.now().toString(36)}`,
    tier: "public",
    joinPolicy: "request",
  });

  // Second user requests to join.
  const b = await newUser(browser, appServer.baseUrl);
  await b.page.goto(`/groups/${groupId}`);
  await b.page.getByTestId("join-group").click();
  await expect(b.page.getByTestId("join-pending")).toBeVisible({ timeout: 10_000 });

  // Manager sees the pending request and approves it.
  await page.getByTestId("space-menu-toggle").click();
  await page.getByTestId("tab-requests").click();
  await page.getByTestId("requests-list").waitFor({ state: "visible", timeout: 10_000 });
  await expect(page.getByTestId("requests-list")).toContainText(b.actor);
  await page.getByTestId("approve-request").first().click();
  // The request leaves the pending list.
  await expect(page.getByTestId("request-row")).toHaveCount(0, { timeout: 10_000 });

  // The second user reloads and is now a member (sees themselves in members).
  await b.page.reload();
  await b.page.getByTestId("space-menu-toggle").click();
  await b.page.getByTestId("tab-members").click();
  await b.page.getByTestId("members-list").waitFor({ state: "visible" });
  await expect(b.page.getByTestId("members-list")).toContainText(b.actor);

  await b.page.context().close();
});

test("guest redeem: a grantsGuest invite provisions a guest with no account", async ({
  page,
  browser,
  appServer,
}) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/groups");

  const groupId = await createGroup(page, {
    name: `Guest ${Date.now().toString(36)}`,
    tier: "group",
    joinPolicy: "invite",
  });
  await createChannel(page, { name: "general", tier: "group" });

  // Mint a guest-granting invite.
  await page.getByTestId("space-menu-toggle").click();
  await page.getByTestId("tab-invites").click();
  await page.getByTestId("invite-grants-guest").check();
  await page.getByTestId("create-invite").click();
  await page.getByTestId("invite-link").waitFor({ state: "visible" });
  const link = (await page.getByTestId("invite-link").textContent())?.trim();
  const token = (link as string).split("/invite/")[1];

  // A brand-new browser (NO account) opens the invite and joins as a guest.
  const context = await browser.newContext({ baseURL: appServer.baseUrl });
  const guest = await context.newPage();
  await guest.goto(`/invite/${token}`);
  await guest.getByTestId("redeem-as-guest").click();

  // Provisioned + routed into the group as an authenticated guest.
  await guest.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await expect(guest.getByTestId("group-name-heading")).toBeVisible({ timeout: 15_000 });
  // The guest holds a live session (the app shell shows an actor).
  await expect(guest.getByTestId("space-rail")).toContainText("@", { timeout: 15_000 });

  await context.close();
  void groupId;
});
