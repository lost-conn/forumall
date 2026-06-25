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

/** A DM message row locator matching `text`. */
function dmRow(page: Page, text: string) {
  return page.locator('[data-testid="dm-message"]').filter({ hasText: text });
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
  // The bubble shows a per-message timestamp (matching the channel chat view).
  await expect(aRows.first().getByTestId("dm-message-time")).toBeVisible({ timeout: 10_000 });
  await expect(aRows.first().getByTestId("dm-message-time")).toHaveText(/\d{1,2}:\d{2}/);

  // B sees it live in the open list/thread. Open the conversation from B's list.
  const dmIdB = await openConversationWith(b.page, a.actor);
  expect(dmIdB).toBe(dmIdA); // dmId derives identically on both sides.
  const bRows = b.page.locator('[data-testid="dm-message"]').filter({ hasText: msg1 });
  await expect(bRows).toHaveCount(1, { timeout: 10_000 });
  await expect(bRows.first()).toHaveAttribute("data-mine", "0");
  await expect(bRows.first().getByTestId("dm-message-time")).toBeVisible({ timeout: 10_000 });

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

// ---------------------------------------------------------------------------
// Parity-with-channel-chat features: reactions, replies, edit/delete,
// attachments, typing. (Card: "DMs need replies/reactions/all chat
// functionality".) Single provider, two browser contexts, conversation open on
// both — exercising the live `dm.reaction` / `dm.typing` events + the §7.2 reply
// reference + the PATCH/DELETE edit/tombstone re-fan.
// ---------------------------------------------------------------------------

/**
 * Two users (A = the fixture page, B = a fresh context) with a DM conversation
 * open on BOTH sides AND a two-way exchange already done, so BOTH have an inbox
 * conversation row (required for the typing + own-message reaction paths, §7.4).
 * Returns both pages + actors + the shared dmId + the two seed texts (`seedA`
 * authored by A → in B's inbox; `seedB` authored by B → in A's inbox).
 */
async function twoUsersInDm(
  page: Page,
  browser: Browser,
  baseUrl: string,
): Promise<{
  a: Page;
  b: Page;
  aActor: string;
  bActor: string;
  dmId: string;
  seedA: string;
  seedB: string;
}> {
  const aReg = await registerUser(page, baseUrl, uniqueHandle());
  const b = await newUser(browser, baseUrl);
  const dmId = await startDm(page, b.actor);
  const seedA = `seeda-${Date.now().toString(36)}`;
  await sendDm(page, seedA);
  await expect(dmRow(page, seedA)).toHaveCount(1, { timeout: 10_000 });

  const dmIdB = await openConversationWith(b.page, aReg.actor);
  expect(dmIdB).toBe(dmId);
  await expect(dmRow(b.page, seedA)).toHaveCount(1, { timeout: 10_000 });

  // B replies so A also gets an inbox conversation row (two-way exchange).
  const seedB = `seedb-${Date.now().toString(36)}`;
  await sendDm(b.page, seedB);
  await expect(dmRow(page, seedB)).toHaveCount(1, { timeout: 10_000 });

  return { a: page, b: b.page, aActor: aReg.actor, bActor: b.actor, dmId, seedA, seedB };
}

test("reactions: B reacts to A's DM → A sees the chip; B removes → it clears", async ({
  page,
  browser,
  appServer,
}) => {
  // B holds A's message in B's inbox (the server-supported reaction path, §8.3):
  // B reacts, the server stores it + fans `dm.reaction` to BOTH participants.
  const { a, b, seedA } = await twoUsersInDm(page, browser, appServer.baseUrl);

  const bRow = dmRow(b, seedA).first();
  await bRow.hover();
  await bRow.getByTestId("react-button").click();
  await b.getByTestId("reaction-picker").waitFor({ state: "visible" });
  await b.locator('[data-testid="reaction-pick"][data-reaction-key="+1"]').click();

  // B sees its own chip with count 1 (optimistic + confirmed).
  const bChip = bRow.locator('[data-testid="reaction-chip"][data-reaction-key="+1"]');
  await expect(bChip).toBeVisible({ timeout: 10_000 });
  await expect(bChip.getByTestId("reaction-count")).toHaveText("1");

  // A sees the same chip live (dm.reaction fans to both participants).
  const aRow = dmRow(a, seedA).first();
  const aChip = aRow.locator('[data-testid="reaction-chip"][data-reaction-key="+1"]');
  await expect(aChip).toBeVisible({ timeout: 10_000 });
  await expect(aChip.getByTestId("reaction-count")).toHaveText("1");

  // B removes it → it clears on BOTH sides.
  await bChip.click();
  await expect(bChip).toHaveCount(0, { timeout: 10_000 });
  await expect(aChip).toHaveCount(0, { timeout: 10_000 });

  await b.context().close();
});

test("replies: A replies to B's message → the reply renders with a quoted parent", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b, seedB } = await twoUsersInDm(page, browser, appServer.baseUrl);

  // A replies to B's message (B's message is in A's inbox + the loaded thread).
  const aSeedRow = dmRow(a, seedB).first();
  await aSeedRow.hover();
  await aSeedRow.getByTestId("dm-reply-button").click();
  await expect(a.getByTestId("dm-composer-reply-pill")).toBeVisible();
  const reply = `reply-${Date.now().toString(36)}`;
  await sendDm(a, reply);

  // A's own reply renders with the reply-quote referencing B's message.
  const aReplyRow = dmRow(a, reply).first();
  await expect(aReplyRow).toBeVisible({ timeout: 10_000 });
  await expect(aReplyRow.getByTestId("reply-quote")).toBeVisible();
  await expect(aReplyRow.getByTestId("reply-quote")).toContainText(seedB);

  // B receives the reply live, also with the quoted parent.
  const bReplyRow = dmRow(b, reply).first();
  await expect(bReplyRow).toBeVisible({ timeout: 10_000 });
  await expect(bReplyRow.getByTestId("reply-quote")).toContainText(seedB);

  await b.context().close();
});

test("edit + delete: A edits then deletes their own DM → BOTH author and recipient reflect it", async ({
  page,
  browser,
  appServer,
}) => {
  // §8.3 + storage-follows-message: the author's sent copy is client-retained,
  // but the server's authoritative copy lives in the RECIPIENT's inbox. The
  // PATCH/DELETE routes now route the edit/tombstone to that copy and fan
  // `dm.message` to the recipient — so editing/deleting one's OWN sent DM updates
  // BOTH the author's own view (+ local store, survives reload) AND the
  // recipient's live view. We assert both sides here.
  const { a, b, seedA } = await twoUsersInDm(page, browser, appServer.baseUrl);

  const aSeed = dmRow(a, seedA).first();
  await expect.poll(() => aSeed.getAttribute("data-message-id")).not.toMatch(/^optimistic:/);
  const seedId = await aSeed.getAttribute("data-message-id");
  const aSeedById = a.locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`);
  // B already holds seedA in their inbox (it was authored by A → B's inbox).
  const bSeedById = b.locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`);
  await expect(bSeedById).toContainText(seedA, { timeout: 10_000 });

  // A edits their own message.
  await aSeedById.hover();
  await aSeedById.getByTestId("dm-edit-message").click();
  const edited = `${seedA}-edited`;
  await aSeedById.getByTestId("dm-edit-input").fill(edited);
  await aSeedById.getByTestId("dm-save-edit").click();
  await expect(aSeedById).toContainText(edited, { timeout: 10_000 });
  await expect(aSeedById.getByTestId("dm-message-edited")).toBeVisible();

  // The RECIPIENT sees the edit live (forwarded to B's inbox + `dm.message`).
  await expect(bSeedById).toContainText(edited, { timeout: 10_000 });
  await expect(bSeedById.getByTestId("dm-message-edited")).toBeVisible();

  // The edit survives a reload on BOTH sides (A from the local sent-store, B from
  // the server's stored inbox copy).
  await a.reload();
  await expect(a.locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`)).toContainText(
    edited,
    { timeout: 15_000 },
  );
  await b.reload();
  await expect(b.locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`)).toContainText(
    edited,
    { timeout: 15_000 },
  );

  // A deletes their own message → tombstone in place (survives reload) AND the
  // recipient's copy is tombstoned too.
  const aSeedById2 = a.locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`);
  a.once("dialog", (d) => void d.accept());
  await aSeedById2.hover();
  await aSeedById2.getByTestId("dm-delete-message").click();
  await expect(aSeedById2.getByTestId("dm-message-tombstone")).toBeVisible({ timeout: 10_000 });

  // The RECIPIENT sees the tombstone live.
  await expect(
    b
      .locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`)
      .getByTestId("dm-message-tombstone"),
  ).toBeVisible({ timeout: 10_000 });

  await a.reload();
  await expect(
    a
      .locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`)
      .getByTestId("dm-message-tombstone"),
  ).toBeVisible({ timeout: 15_000 });
  await b.reload();
  await expect(
    b
      .locator(`[data-testid="dm-message"][data-message-id="${seedId}"]`)
      .getByTestId("dm-message-tombstone"),
  ).toBeVisible({ timeout: 15_000 });

  await b.context().close();
});

test("attachment: A attaches an image to a DM → it renders for both", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInDm(page, browser, appServer.baseUrl);

  // A 1x1 transparent PNG.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const buffer = Buffer.from(pngBase64, "base64");

  await a.getByTestId("dm-file-input").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer,
  });
  await expect(a.getByTestId("dm-composer-attachments")).toBeVisible({ timeout: 10_000 });
  await sendDm(a, "look at this");

  // The inline <img> appears for A and B and actually loaded.
  const aImg = a.getByTestId("attachment-image").first();
  await expect(aImg).toBeVisible({ timeout: 10_000 });
  await expect(b.getByTestId("attachment-image").first()).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => aImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  await b.context().close();
});

test("typing: A typing in a DM → B sees the indicator; it clears on blur", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInDm(page, browser, appServer.baseUrl);

  const input = a.getByTestId("dm-composer-input");
  await input.click();
  await input.pressSequentially("drafting…", { delay: 20 });

  const indicator = b.getByTestId("dm-typing-indicator");
  await expect(indicator).toBeVisible({ timeout: 10_000 });
  await expect(indicator).toContainText("typing");

  await input.evaluate((el: HTMLElement) => el.blur());
  await expect(b.getByTestId("dm-typing-indicator")).toHaveCount(0, { timeout: 10_000 });

  await b.context().close();
});

test("inline formatting: A sends a formatted DM → bold/italic/code render for both", async ({
  page,
  browser,
  appServer,
}) => {
  const { a, b } = await twoUsersInDm(page, browser, appServer.baseUrl);

  const tag = `fmt-${Date.now().toString(36)}`;
  await sendDm(a, `${tag} **bold** _italic_ \`code\``);

  // Author's own copy renders the marks as real elements (no raw `**`/`_`).
  const aBody = dmRow(a, tag).first().getByTestId("dm-message-text");
  await expect(aBody.locator("strong")).toHaveText("bold");
  await expect(aBody.locator("em")).toHaveText("italic");
  await expect(aBody.locator("code")).toHaveText("code");

  // The recipient sees the same formatting live.
  const bBody = dmRow(b, tag).first().getByTestId("dm-message-text");
  await expect(bBody.locator("strong")).toHaveText("bold");
  await expect(bBody.locator("em")).toHaveText("italic");
  await expect(bBody.locator("code")).toHaveText("code");

  await b.context().close();
});
