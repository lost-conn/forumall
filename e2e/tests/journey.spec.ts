/**
 * P9 consolidated single-provider e2e smoke journey.
 *
 * ONE test that walks the core happy path in sequence against a single freshly-
 * booted provider (serving the production-built web bundle the harness builds),
 * proving the whole stack is wired together end-to-end. The per-feature specs
 * ({auth,groups,chat,dms,social,feed}.spec.ts) do the exhaustive coverage; this
 * is a focused smoke that strings the pieces into one flow:
 *
 *   1. User A registers → lands authenticated (connect → register → in-browser
 *      device keygen → signed session).
 *   2. A creates an open public group.
 *   3. A creates a public text channel and opens it.
 *   4. A posts a message; the optimistic echo reconciles to one canonical copy.
 *   5. A second user B (second browser context) joins the open group and sees
 *      A's message live over WS.
 *   6. B reacts; A sees the reaction live.
 *   7. A edits the message; B sees the edit. A deletes it; B sees the tombstone.
 *   8. A opens a DM to B and sends; B receives it live (inbox + conversation list).
 */
import type { Browser, Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { expect, test } from "../harness/fixtures.ts";

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

/** Send a message via the channel composer (Enter-to-send). */
async function compose(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** Send a DM via the DM composer (Enter-to-send). */
async function sendDm(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("dm-composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

test("core round trip: register → group → channel → post → B joins/sees live → react → edit/delete → DM", async ({
  page,
  browser,
  appServer,
}) => {
  const baseUrl = appServer.baseUrl;

  // -- 1. User A registers and lands authenticated ---------------------------
  const a = page;
  const aReg = await registerUser(a, baseUrl, uniqueHandle());

  // -- 2. A creates an open public group -------------------------------------
  await a.goto("/groups");
  const groupId = await createGroup(a, {
    name: `Journey ${Date.now().toString(36)}`,
    tier: "public",
    joinPolicy: "open",
  });

  // -- 3. A creates a public text channel and opens it -----------------------
  await createChannel(a, "general", "public");
  await openChat(a, "general");

  // -- 4. A posts a message; optimistic echo reconciles to one canonical copy -
  const text = `journey-${Date.now().toString(36)}`;
  await compose(a, text);
  const aRow = a.locator('[data-testid="message-row"]').filter({ hasText: text }).first();
  await expect(aRow).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => aRow.getAttribute("data-message-id")).not.toMatch(/^optimistic:/);
  const messageId = await aRow.getAttribute("data-message-id");
  if (!messageId) throw new Error("message-row missing data-message-id after reconcile");
  const aRowById = a.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);

  // -- 5. B (second context) joins the open group and sees the message live ---
  const b = await newUser(browser, baseUrl);
  await b.page.goto(`/groups/${groupId}`);
  await b.page.getByTestId("join-group").click();
  await b.page.getByTestId("channels-list").waitFor({ state: "visible", timeout: 10_000 });
  await expect(b.page.getByTestId("join-card")).toHaveCount(0, { timeout: 10_000 });
  await openChat(b.page, "general");

  const bRow = b.page.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);
  await expect(bRow).toBeVisible({ timeout: 10_000 });
  await expect(bRow).toContainText(text);

  // -- 6. B reacts; A sees the reaction live ---------------------------------
  await bRow.getByTestId("react-button").click();
  await b.page.getByTestId("reaction-picker").waitFor({ state: "visible" });
  await b.page.locator('[data-testid="reaction-pick"][data-reaction-key="+1"]').click();

  const aChip = aRowById.locator('[data-testid="reaction-chip"][data-reaction-key="+1"]');
  await expect(aChip).toBeVisible({ timeout: 10_000 });
  await expect(aChip.getByTestId("reaction-count")).toHaveText("1");

  // -- 7. A edits the message → B sees the edit; A deletes → B sees tombstone -
  await aRowById.hover();
  await aRowById.getByTestId("edit-message").click();
  const edited = `${text}-edited`;
  await aRowById.getByTestId("edit-input").fill(edited);
  await aRowById.getByTestId("save-edit").click();

  await expect(bRow).toContainText(edited, { timeout: 10_000 });
  await expect(bRow.getByTestId("message-edited")).toBeVisible();

  a.once("dialog", (d) => void d.accept());
  await aRowById.hover();
  await aRowById.getByTestId("delete-message").click();
  await expect(bRow.getByTestId("message-tombstone")).toBeVisible({ timeout: 10_000 });

  // -- 8. A opens a DM to B → B receives it live -----------------------------
  await a.goto("/dms");
  await a.getByTestId("open-new-dm").click();
  await a.getByTestId("new-dm-modal").waitFor({ state: "visible" });
  await a.getByTestId("new-dm-recipient").fill(b.actor);
  await a.getByTestId("new-dm-start").click();
  await a.waitForURL(/\/dms\/dm_[0-9a-f]{64}$/, { timeout: 15_000 });
  const aThread = a.getByTestId("dm-thread");
  await aThread.waitFor({ state: "visible", timeout: 10_000 });
  const dmId = await aThread.getAttribute("data-dm-id");
  if (!dmId) throw new Error("dm-thread missing data-dm-id");

  const dmText = `dm-${Date.now().toString(36)}`;
  await sendDm(a, dmText);
  const aDm = a.locator('[data-testid="dm-message"]').filter({ hasText: dmText });
  await expect(aDm).toHaveCount(1, { timeout: 10_000 });

  // B receives it live: the conversation surfaces in B's list naming A, and the
  // message is in the thread.
  await b.page.goto("/dms");
  const bConvo = b.page.locator(
    `[data-testid="dm-conversation"][data-counterparty="${aReg.actor}"]`,
  );
  await bConvo.waitFor({ state: "visible", timeout: 15_000 });
  await bConvo.click();
  const bThread = b.page.getByTestId("dm-thread");
  await bThread.waitFor({ state: "visible", timeout: 10_000 });
  expect(await bThread.getAttribute("data-dm-id")).toBe(dmId);
  const bDm = b.page.locator('[data-testid="dm-message"]').filter({ hasText: dmText });
  await expect(bDm).toHaveCount(1, { timeout: 10_000 });
  await expect(bDm.first()).toHaveAttribute("data-mine", "0");

  await b.page.context().close();
});
