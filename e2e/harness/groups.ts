/**
 * Group, channel and guest helpers for e2e specs, driving the real UI.
 *
 * `createGroup` / `createChannel` fill the create forms of the open group view;
 * `openAsGuest` takes a signed-in page, mints a guest-granting invite on a new
 * invite-only group, and redeems it in a brand-new browser context, leaving
 * that context signed in as a guest (§5.6).
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";

/** Open the create-group form, fill it, submit, and return the new group id. */
export async function createGroup(
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
export async function createChannel(
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

/**
 * From the signed-in `page`, create an invite-only group with a channel, mint a
 * guest-granting invite, and redeem it in a brand-new browser context (no
 * account). Resolves once the guest has landed in the group with a live
 * session. The caller closes `context`.
 */
export async function openAsGuest(
  page: Page,
  browser: Browser,
  baseUrl: string,
): Promise<{ guest: Page; context: BrowserContext; groupId: string }> {
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
  const context = await browser.newContext({ baseURL: baseUrl });
  const guest = await context.newPage();
  await guest.goto(`/invite/${token}`);
  await guest.getByTestId("redeem-as-guest").click();

  // Provisioned + routed into the group as an authenticated guest.
  await guest.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await guest.getByTestId("group-name-heading").waitFor({ state: "visible", timeout: 15_000 });
  return { guest, context, groupId };
}
