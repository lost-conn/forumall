/**
 * P8 DMs UI e2e (single provider, two browser contexts A & B).
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server and
 * exercises the §7.4 / §8.3 DM experience across TWO users on the SAME provider:
 *
 *  1. A opens a DM to B and sends → B sees it live (inbox + `dm.message`) and it
 *     appears in B's conversation list.
 *  2. A's OWN thread shows A's sent message from the LOCAL sent-store, while A's
 *     inbox (`GET /api/dms/{dmId}/messages`) does NOT contain it (no sender copy).
 *  3. B replies → A sees the reply live; both threads show the full back-and-forth.
 *  4. Reload persistence: A still sees their sent history (local store) and B still
 *     sees received history (server).
 *  5. The `dmId` derives identically on both sides (the conversation lines up).
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

/** Start a new DM to `recipient` from the DMs screen; returns the derived dmId. */
async function startDm(page: Page, recipient: string): Promise<string> {
  await page.goto("/dms");
  await page.getByTestId("open-new-dm").click();
  await page.getByTestId("new-dm-modal").waitFor({ state: "visible" });
  await page.getByTestId("new-dm-recipient").fill(recipient);
  await page.getByTestId("new-dm-start").click();
  await page.waitForURL(/\/dms\/dm_[0-9a-f]{64}$/, { timeout: 15_000 });
  const thread = page.getByTestId("dm-thread");
  await thread.waitFor({ state: "visible", timeout: 10_000 });
  const dmId = await thread.getAttribute("data-dm-id");
  if (!dmId) throw new Error("dm-thread missing data-dm-id");
  return dmId;
}

/** Open an existing conversation from the list by counterparty actor. */
async function openConversationWith(page: Page, counterparty: string): Promise<string> {
  await page.goto("/dms");
  const row = page.locator(`[data-testid="dm-conversation"][data-counterparty="${counterparty}"]`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
  const thread = page.getByTestId("dm-thread");
  await thread.waitFor({ state: "visible", timeout: 10_000 });
  const dmId = await thread.getAttribute("data-dm-id");
  if (!dmId) throw new Error("dm-thread missing data-dm-id");
  return dmId;
}

/** Send a DM via the composer (Enter-to-send). */
async function sendDm(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("dm-composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** Drive the in-browser signing client to read A's own inbox for a dmId. */
async function inboxTextsFor(page: Page, dmId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const client = (
      globalThis as unknown as {
        __forumall_dmInbox?: (dmId: string) => Promise<string[]>;
      }
    ).__forumall_dmInbox;
    if (!client) throw new Error("__forumall_dmInbox hook missing");
    return client(id);
  }, dmId);
}

test("A → B live DM: B sees it live + in the list; A's copy is local-only (no sender inbox copy)", async ({
  page,
  browser,
  appServer,
}) => {
  const a = { page, actor: "" };
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  a.actor = aReg.actor;
  const b = await newUser(browser, appServer.baseUrl);

  // A opens a DM to B and sends.
  const dmIdA = await startDm(a.page, b.actor);
  const msg1 = `hello-${Date.now().toString(36)}`;
  await sendDm(a.page, msg1);

  // A's own thread shows the sent message (optimistic → confirmed, exactly once).
  const aRows = a.page.locator('[data-testid="dm-message"]').filter({ hasText: msg1 });
  await expect(aRows).toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(() => aRows.first().getAttribute("data-message-id"))
    .not.toMatch(/^optimistic:/);
  await expect(aRows.first()).toHaveAttribute("data-mine", "1");

  // B sees it live in the open list/thread. Open the conversation from B's list.
  const dmIdB = await openConversationWith(b.page, a.actor);
  expect(dmIdB).toBe(dmIdA); // dmId derives identically on both sides.
  const bRows = b.page.locator('[data-testid="dm-message"]').filter({ hasText: msg1 });
  await expect(bRows).toHaveCount(1, { timeout: 10_000 });
  await expect(bRows.first()).toHaveAttribute("data-mine", "0");

  // The conversation appears in B's list naming A.
  await expect(
    b.page.locator(`[data-testid="dm-conversation"][data-counterparty="${a.actor}"]`),
  ).toHaveCount(1);

  // §8.3: A's OWN inbox for this dmId does NOT contain the sent message — the UI
  // showed it purely from the local sent-store.
  const aInbox = await inboxTextsFor(a.page, dmIdA);
  expect(aInbox).not.toContain(msg1);
  // B's inbox DOES contain it (the recipient's provider stored it).
  const bInbox = await inboxTextsFor(b.page, dmIdB);
  expect(bInbox).toContain(msg1);

  await b.page.context().close();
});

test("back-and-forth: B replies → A sees it live; both threads show the full exchange", async ({
  page,
  browser,
  appServer,
}) => {
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const b = await newUser(browser, appServer.baseUrl);

  const dmIdA = await startDm(page, b.actor);
  const aMsg = `a-says-${Date.now().toString(36)}`;
  await sendDm(page, aMsg);
  await expect(page.locator('[data-testid="dm-message"]').filter({ hasText: aMsg })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  // B opens the conversation, sees A's message, and replies.
  const dmIdB = await openConversationWith(b.page, aReg.actor);
  expect(dmIdB).toBe(dmIdA);
  await expect(b.page.locator('[data-testid="dm-message"]').filter({ hasText: aMsg })).toHaveCount(
    1,
    { timeout: 10_000 },
  );
  const bMsg = `b-says-${Date.now().toString(36)}`;
  await sendDm(b.page, bMsg);

  // A sees B's reply live (A still has the thread open).
  await expect(page.locator('[data-testid="dm-message"]').filter({ hasText: bMsg })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  // Both threads now show the full back-and-forth: each side has its own SENT
  // (mine=1) + the other's RECEIVED (mine=0).
  for (const ctx of [
    { p: page, ownText: aMsg, otherText: bMsg },
    { p: b.page, ownText: bMsg, otherText: aMsg },
  ]) {
    const own = ctx.p.locator('[data-testid="dm-message"]').filter({ hasText: ctx.ownText });
    const other = ctx.p.locator('[data-testid="dm-message"]').filter({ hasText: ctx.otherText });
    await expect(own).toHaveCount(1);
    await expect(own).toHaveAttribute("data-mine", "1");
    await expect(other).toHaveCount(1);
    await expect(other).toHaveAttribute("data-mine", "0");
  }

  await b.page.context().close();
});

test("reload persistence: A keeps sent history (local), B keeps received history (server)", async ({
  page,
  browser,
  appServer,
}) => {
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const b = await newUser(browser, appServer.baseUrl);

  const dmIdA = await startDm(page, b.actor);
  const aMsg = `persist-a-${Date.now().toString(36)}`;
  await sendDm(page, aMsg);
  await expect(page.locator('[data-testid="dm-message"]').filter({ hasText: aMsg })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  // B receives it and replies, so B has a server-stored received message + A has
  // a server-stored received message (B's reply).
  const dmIdB = await openConversationWith(b.page, aReg.actor);
  const bMsg = `persist-b-${Date.now().toString(36)}`;
  await sendDm(b.page, bMsg);
  await expect(page.locator('[data-testid="dm-message"]').filter({ hasText: bMsg })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  // Reload A: their SENT message is restored from the local sent-store (the
  // server has no sender copy), and B's reply is restored from A's inbox.
  await page.reload();
  await page.goto(`/dms/${dmIdA}`);
  await expect(page.locator('[data-testid="dm-message"]').filter({ hasText: aMsg })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid="dm-message"]').filter({ hasText: bMsg })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  // A's own inbox still does NOT contain A's sent message (proves local-only).
  expect(await inboxTextsFor(page, dmIdA)).not.toContain(aMsg);

  // Reload B: their received history (A's message) is restored from the server.
  await b.page.reload();
  await b.page.goto(`/dms/${dmIdB}`);
  await expect(b.page.locator('[data-testid="dm-message"]').filter({ hasText: aMsg })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  await expect(b.page.locator('[data-testid="dm-message"]').filter({ hasText: bMsg })).toHaveCount(
    1,
    { timeout: 15_000 },
  );

  await b.page.context().close();
});

test("trust-boundary notice is shown on the DMs screen", async ({ page, appServer }) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.goto("/dms");
  const notice = page.getByTestId("dm-trust-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/not end-to-end encrypted/i);
});
