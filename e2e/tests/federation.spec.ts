/**
 * P9 two-provider federation e2e — proves OFSCP federation end-to-end through the
 * REAL web client against TWO real providers (A = alice's home, B = bob's home),
 * each booted on its own ephemeral port with the insecure-localhost federation
 * transport on (so each resolves the other's §4.6 user-keys / §3.1 discovery over
 * loopback). The browser loads A's app for alice and B's app for bob; every
 * cross-provider action is signed by the actor's HOME key and verified by the
 * peer after resolving that key via §4.6.
 *
 * Scenarios (spec §7.4/§8.3, §6.7, §8.2/§8.5, §7.6, §4.6):
 *  1. Cross-provider DM: alice (A) → bob@B live (`dm.message` + inbox on B), her
 *     local sent copy on A; bob replies → alice sees it live on A. Same `dmId`.
 *  2. Cross-provider contact: alice requests bob@B → bob sees it on B → accepts →
 *     both sides accepted (alice's on A, bob's on B).
 *  3. Remote channel live: bob (B) makes an open public group+channel; alice (A)
 *     joins it on B + opens it (Home feed direct-WS to B) → bob's post reaches
 *     alice live; bob's edit + delete reach alice too.
 *  4. Remote follow in feed: alice follows bob's B-channel → it appears in alice's
 *     home feed (read live from B).
 *
 * Scenarios 3 + 4 share one flow: the cross-provider *join* (the only action with
 * no UI input) is driven via the `__forumall_federation` in-browser hook — a
 * signed per-host call through the same home identity the product signs with —
 * then the REAL feed controller opens the remote channel's history + direct WS to
 * B and folds live events into Home, exactly as the product does for a follow.
 */
import type { Browser, Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { type BootedServer, expect, test } from "../harness/fixtures.ts";

/** Register a fresh user in a brand-new context bound to one provider; return its page. */
async function userOn(
  browser: Browser,
  server: BootedServer,
): Promise<{ page: Page; actor: string; handle: string }> {
  const context = await browser.newContext({ baseURL: server.baseUrl });
  const page = await context.newPage();
  const { handle, actor } = await registerUser(page, server.baseUrl, uniqueHandle());
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

/** Read a page's OWN DM inbox (signed) for a dmId via the in-browser hook. */
async function inboxTextsFor(page: Page, dmId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const hook = (
      globalThis as unknown as { __forumall_dmInbox?: (dmId: string) => Promise<string[]> }
    ).__forumall_dmInbox;
    if (!hook) throw new Error("__forumall_dmInbox hook missing");
    return hook(id);
  }, dmId);
}

/** Drive a SIGNED cross-provider request from `page`'s session via the hook. */
async function fed(
  page: Page,
  host: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async (args) => {
      const hook = (
        globalThis as unknown as {
          __forumall_federation?: (
            host: string,
            method: string,
            path: string,
            body?: unknown,
          ) => Promise<{ status: number; body: unknown }>;
        }
      ).__forumall_federation;
      if (!hook) throw new Error("__forumall_federation hook missing");
      return hook(args.host, args.method, args.path, args.body);
    },
    { host, method, path, body },
  );
}

// ---------------------------------------------------------------------------
// 1) Cross-provider DM
// ---------------------------------------------------------------------------

test("cross-provider DM: alice@A ↔ bob@B live, same dmId, recipient-only inbox", async ({
  browser,
  twoProviders,
}) => {
  const { a: A, b: B } = twoProviders;
  const alice = await userOn(browser, A);
  const bob = await userOn(browser, B);

  // alice (on A) DMs bob@B → delivered to bob's home provider B, signed by alice.
  const dmIdA = await startDm(alice.page, bob.actor);
  const msg1 = `cross-hello-${Date.now().toString(36)}`;
  await sendDm(alice.page, msg1);

  // alice's own thread shows her sent copy (optimistic → confirmed, exactly once).
  const aRows = alice.page.locator('[data-testid="dm-message"]').filter({ hasText: msg1 });
  await expect(aRows).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => aRows.first().getAttribute("data-message-id"))
    .not.toMatch(/^optimistic:/);
  await expect(aRows.first()).toHaveAttribute("data-mine", "1");

  // bob (on B) sees it live + in his conversation list; the dmId matches.
  const dmIdB = await openConversationWith(bob.page, alice.actor);
  expect(dmIdB).toBe(dmIdA);
  const bRows = bob.page.locator('[data-testid="dm-message"]').filter({ hasText: msg1 });
  await expect(bRows).toHaveCount(1, { timeout: 15_000 });
  await expect(bRows.first()).toHaveAttribute("data-mine", "0");

  // §8.3: stored in BOB's inbox on B, NOT in alice's inbox on A.
  expect(await inboxTextsFor(bob.page, dmIdB)).toContain(msg1);
  expect(await inboxTextsFor(alice.page, dmIdA)).not.toContain(msg1);

  // bob replies → alice sees it live on A (delivered to alice's home A).
  const reply = `cross-reply-${Date.now().toString(36)}`;
  await sendDm(bob.page, reply);
  await expect(
    alice.page.locator('[data-testid="dm-message"]').filter({ hasText: reply }),
  ).toHaveCount(1, { timeout: 15_000 });
  // alice's inbox on A now holds bob's reply (the received copy).
  expect(await inboxTextsFor(alice.page, dmIdA)).toContain(reply);

  await alice.page.context().close();
  await bob.page.context().close();
});

// ---------------------------------------------------------------------------
// 2) Cross-provider contact
// ---------------------------------------------------------------------------

test("cross-provider contact: alice requests bob@B → bob accepts → both accepted", async ({
  browser,
  twoProviders,
}) => {
  const { a: A, b: B } = twoProviders;
  const alice = await userOn(browser, A);
  const bob = await userOn(browser, B);

  // alice requests bob@B (records her outgoing row on A + mirrors to B).
  await alice.page.goto("/contacts");
  await alice.page.getByTestId("add-contact-input").fill(bob.actor);
  await alice.page.getByTestId("add-contact-submit").click();
  await expect(
    alice.page.locator(`[data-testid="contact-row"][data-user="${bob.actor}"]`),
  ).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
  await expect(
    alice.page.locator(`[data-testid="contact-row"][data-user="${bob.actor}"]`),
  ).toHaveAttribute("data-direction", "outgoing");

  // bob sees the incoming request on B and accepts.
  await bob.page.goto("/contacts");
  const bobRow = bob.page.locator(`[data-testid="contact-row"][data-user="${alice.actor}"]`);
  await expect(bobRow).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
  await expect(bobRow).toHaveAttribute("data-direction", "incoming");
  await bobRow.getByTestId("accept-contact").click();

  // bob's side flips to accepted on B (mirror to A applies alice's accept too).
  await expect(bobRow).toHaveAttribute("data-state", "accepted", { timeout: 15_000 });

  // alice's side flips to accepted on A (her outgoing pending → accepted via mirror).
  await alice.page.goto("/contacts");
  await expect(
    alice.page.locator(`[data-testid="contact-row"][data-user="${bob.actor}"]`),
  ).toHaveAttribute("data-state", "accepted", { timeout: 15_000 });

  await alice.page.context().close();
  await bob.page.context().close();
});

// ---------------------------------------------------------------------------
// 3) + 4) Remote channel live + remote follow in feed
// ---------------------------------------------------------------------------

/**
 * Create an OPEN public group + channel on `page`'s own provider (via the signed
 * federation hook, since the create-group UI is a multi-step flow this test isn't
 * exercising). Returns the ids. Tier `public` makes the channel readable without
 * membership (§5.5); `joinPolicy: open` lets a remote actor join.
 */
async function createOpenChannel(page: Page): Promise<{ groupId: string; channelId: string }> {
  // The harness pins each provider's DOMAIN to its `location.host`, so the page's
  // own host IS its signing authority.
  const host = await page.evaluate(() => location.host);
  const g = await fed(page, host, "POST", "/api/groups", {
    name: `fed-grp-${Date.now().toString(36)}`,
    tier: "public",
    joinPolicy: "open",
  });
  const groupId = (g.body as { id: string }).id;
  const c = await fed(page, host, "POST", `/api/groups/${groupId}/channels`, {
    name: `fed-chn-${Date.now().toString(36)}`,
    type: "text",
    tier: "public",
  });
  const channelId = (c.body as { id: string }).id;
  return { groupId, channelId };
}

/** Open a channel in `page`'s real chat UI (group view → open-channel). */
async function openChannelUi(page: Page, groupId: string, channelId: string): Promise<void> {
  await page.goto(`/groups/${groupId}`);
  const row = page.locator(`[data-testid="channel-row"]`).first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(`[data-testid="open-channel"]`).first().click();
  const chat = page.locator(`[data-testid="chat-view"][data-channel-id="${channelId}"]`);
  await chat.waitFor({ state: "visible", timeout: 15_000 });
}

/** Post a message in the open chat composer (real WS `message.create`). */
async function postMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await expect(page.locator('[data-testid="message-text"]').filter({ hasText: text })).toHaveCount(
    1,
    { timeout: 15_000 },
  );
}

test("remote channel: alice@A joins bob's B-channel, sees his post/edit/delete live; it shows in her feed", async ({
  browser,
  twoProviders,
}) => {
  const { a: A, b: B } = twoProviders;
  const aHost = A.baseUrl.replace(/^https?:\/\//, "");
  const bHost = B.baseUrl.replace(/^https?:\/\//, "");
  const alice = await userOn(browser, A);
  const bob = await userOn(browser, B);

  // bob (on B) creates an OPEN public group + channel and opens it in his real UI
  // (so his subsequent posts ride the product's WS `message.create` path).
  const { groupId, channelId } = await createOpenChannel(bob.page);
  await openChannelUi(bob.page, groupId, channelId);

  // alice (on A) JOINS bob's channel ON B — signed by alice, B resolves her key
  // via §4.6 (reachable over loopback thanks to the insecure-localhost transport).
  const joinRes = await fed(
    alice.page,
    bHost,
    "POST",
    `/api/groups/${groupId}/channels/${channelId}/join`,
    {},
  );
  expect([200, 201, 202, 204]).toContain(joinRes.status);

  // alice follows the channel's canonical B URI → her REAL feed controller opens
  // it: reads history from B + opens a direct authenticated WS to B (§8.5) and
  // folds live events into Home.
  const channelUri = `https://${bHost}/api/groups/${groupId}/channels/${channelId}`;
  const followRes = await fed(alice.page, aHost, "POST", "/api/me/follows", {
    channel: channelUri,
    groupId,
  });
  expect([200, 201]).toContain(followRes.status);

  // alice opens Home → the feed controller opens the remote channel (direct WS to B).
  await alice.page.goto("/");
  await alice.page.getByTestId("home-feed").waitFor({ state: "visible", timeout: 15_000 });
  await expect(alice.page.getByTestId("feed-follow-count")).toBeVisible({ timeout: 15_000 });

  // bob posts via his real composer → alice receives it LIVE in her feed over the
  // direct WS to B (scenario 3 + scenario 4: it appears in her home feed).
  const post = `remote-post-${Date.now().toString(36)}`;
  await postMessage(bob.page, post);
  const feedItem = alice.page.locator('[data-testid="feed-item"]').filter({ hasText: post });
  await expect(feedItem).toHaveCount(1, { timeout: 20_000 });
  const messageId = await feedItem.first().getAttribute("data-message-id");
  if (!messageId) throw new Error("feed item missing data-message-id");

  // bob edits the message in his UI → the edit reaches alice live (in-place).
  const edited = `remote-edit-${Date.now().toString(36)}`;
  await editMessageUi(bob.page, messageId, edited);
  await expect(
    alice.page.locator('[data-testid="feed-item"]').filter({ hasText: edited }),
  ).toHaveCount(1, { timeout: 20_000 });

  // bob deletes the message in his UI → the tombstone reaches alice live.
  await deleteMessageUi(bob.page, messageId);
  await expect(
    alice.page
      .locator(`[data-testid="feed-item"][data-message-id="${messageId}"]`)
      .getByTestId("feed-item-tombstone"),
  ).toBeVisible({ timeout: 20_000 });

  await alice.page.context().close();
  await bob.page.context().close();
});

/** Edit a message via the chat UI (hover row → edit → type → save with Enter). */
async function editMessageUi(page: Page, messageId: string, text: string): Promise<void> {
  const row = page.locator(`[data-message-id="${messageId}"]`).first();
  await row.hover();
  await row.getByTestId("edit-message").click();
  const editor = page.getByTestId("edit-input");
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  await editor.fill(text);
  await editor.press("Enter");
}

/** Delete a message via the chat UI (hover row → delete → confirm). */
async function deleteMessageUi(page: Page, messageId: string): Promise<void> {
  const row = page.locator(`[data-message-id="${messageId}"]`).first();
  await row.hover();
  page.once("dialog", (d) => void d.accept());
  await row.getByTestId("delete-message").click();
}
