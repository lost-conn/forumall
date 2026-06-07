/**
 * P8 presence + contacts + privacy e2e (single provider, two browser contexts A & B).
 *
 * Drives the real SolidJS client against a real ephemeral @forumall/server and
 * exercises the §6 (privacy / profile / contacts) + §7.5 (WS presence) surfaces
 * across TWO users on the SAME provider:
 *
 *  1. Contacts request → accept: A requests B, B sees the incoming pending row,
 *     accepts, and BOTH sides show an accepted contact.
 *  2. Presence flips live: with A & B contacts, B sees A online; A sets `dnd` and
 *     B sees the dnd state; A's context closes and B sees A flip to offline.
 *  3. Contacts-tier visibility: A sets `presenceVisibility=contacts`; a NON-contact
 *     B sees A offline; after a mutual accept B sees A's real presence.
 *  4. `nobody` hides: A sets `presenceVisibility=nobody` → an accepted-contact B
 *     still sees A offline.
 *
 * Presence is timing-sensitive: we use web-first assertions + `expect.poll` with
 * generous timeouts, and the harness pins short WS heartbeat/idle timings so an
 * ungraceful drop still resolves to offline quickly (a clean close is immediate).
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

/** Send a contact request to `actor` from the Contacts screen. */
async function sendContactRequest(page: Page, actor: string): Promise<void> {
  await page.goto("/contacts");
  await page.getByTestId("add-contact-input").fill(actor);
  await page.getByTestId("add-contact-submit").click();
}

/** The presence dot for a subject actor (locator). */
function presenceDot(page: Page, actor: string) {
  return page.locator(`[data-testid="presence-dot"][data-actor="${actor}"]`).first();
}

/** Poll a subject's observed availability via the dot's data attribute. */
async function availabilityOf(page: Page, actor: string): Promise<string | null> {
  const dot = presenceDot(page, actor);
  if ((await dot.count()) === 0) return null;
  return dot.getAttribute("data-availability");
}

// ---------------------------------------------------------------------------

test("contacts: A requests → B sees incoming → B accepts → both show accepted", async ({
  page,
  browser,
  appServer,
}) => {
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const b = await newUser(browser, appServer.baseUrl);

  // A sends a contact request to B.
  await sendContactRequest(page, b.actor);
  // A's outgoing pending row appears.
  await expect(
    page.locator(`[data-testid="contact-row"][data-user="${b.actor}"][data-state="pending"]`),
  ).toHaveCount(1, { timeout: 10_000 });

  // B opens contacts and sees the incoming pending request.
  await b.page.goto("/contacts");
  const incoming = b.page.locator(
    `[data-testid="contact-row"][data-user="${aReg.actor}"][data-direction="incoming"]`,
  );
  await expect(incoming).toHaveCount(1, { timeout: 10_000 });

  // B accepts.
  await incoming.getByTestId("accept-contact").click();

  // Both sides now show an accepted contact.
  await expect(
    b.page.locator(`[data-testid="contact-row"][data-user="${aReg.actor}"][data-state="accepted"]`),
  ).toHaveCount(1, { timeout: 10_000 });

  await page.goto("/contacts");
  await expect(
    page.locator(`[data-testid="contact-row"][data-user="${b.actor}"][data-state="accepted"]`),
  ).toHaveCount(1, { timeout: 10_000 });

  await b.page.context().close();
});

test("presence flips live: B sees A online, then dnd, then offline on disconnect", async ({
  page,
  browser,
  appServer,
}) => {
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const b = await newUser(browser, appServer.baseUrl);

  // A makes presence public so any authenticated viewer can observe it (the server
  // default is `sharedGroups`, which A & B don't satisfy — this isolates the pure
  // presence mechanics from the visibility tiers, which the next tests cover).
  await page.goto("/settings");
  await page.getByTestId("settings-nav-privacy").click();
  await page.getByTestId("presence-visibility").selectOption("public");
  await page.getByTestId("privacy-save").click();
  await expect(page.getByTestId("privacy-saved")).toBeVisible({ timeout: 10_000 });

  // B watches A's presence by requesting them as a contact (the contacts screen
  // subscribes to every listed actor, pending or not). A is connected → online.
  await sendContactRequest(b.page, aReg.actor);
  await expect(
    b.page.locator(`[data-testid="contact-row"][data-user="${aReg.actor}"]`),
  ).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 15_000 }).toBe("online");

  // A sets dnd via the self-presence control → B sees the dnd state.
  await page.getByTestId("self-presence-toggle").click();
  await page.getByTestId("set-presence-dnd").click();
  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 15_000 }).toBe("dnd");

  // A disconnects (close the whole context) → B sees A flip to offline. The server
  // marks offline on the WS close; allow for heartbeat/idle timing.
  await page.context().close();
  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 20_000 }).toBe("offline");

  await b.page.context().close();
});

test("contacts-tier presence: non-contact sees offline; after accept sees real presence", async ({
  page,
  browser,
  appServer,
}) => {
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const b = await newUser(browser, appServer.baseUrl);

  // A restricts presence to contacts only.
  await page.goto("/settings");
  await page.getByTestId("settings-nav-privacy").click();
  await page.getByTestId("presence-visibility").selectOption("contacts");
  await page.getByTestId("privacy-save").click();
  await expect(page.getByTestId("privacy-saved")).toBeVisible({ timeout: 10_000 });

  // B sends A a contact request (so B's contacts screen subscribes to A's presence)
  // but A has NOT accepted yet → B is not a contact → B sees A as uniform offline.
  await sendContactRequest(b.page, aReg.actor);
  await expect(
    b.page.locator(`[data-testid="contact-row"][data-user="${aReg.actor}"][data-state="pending"]`),
  ).toHaveCount(1, { timeout: 10_000 });
  // A is connected, but the contacts-tier filter hides it from a non-contact.
  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 15_000 }).toBe("offline");

  // A accepts B's request → now they are contacts → B sees A's real presence.
  await page.goto("/contacts");
  const incoming = page.locator(
    `[data-testid="contact-row"][data-user="${b.actor}"][data-direction="incoming"]`,
  );
  await expect(incoming).toHaveCount(1, { timeout: 10_000 });
  await incoming.getByTestId("accept-contact").click();

  // B re-reads presence via a fresh subscription snapshot (reload re-subscribes).
  await b.page.reload();
  await b.page.goto("/contacts");
  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 20_000 }).toBe("online");

  await b.page.context().close();
});

test("`nobody` hides presence: visible viewer flips to offline", async ({
  page,
  browser,
  appServer,
}) => {
  const aReg = await registerUser(page, appServer.baseUrl, uniqueHandle());
  const b = await newUser(browser, appServer.baseUrl);

  // A makes presence public so B can see it; B watches via a contact request.
  await page.goto("/settings");
  await page.getByTestId("settings-nav-privacy").click();
  await page.getByTestId("presence-visibility").selectOption("public");
  await page.getByTestId("privacy-save").click();
  await expect(page.getByTestId("privacy-saved")).toBeVisible({ timeout: 10_000 });

  await sendContactRequest(b.page, aReg.actor);
  await expect(
    b.page.locator(`[data-testid="contact-row"][data-user="${aReg.actor}"]`),
  ).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 15_000 }).toBe("online");

  // A sets presenceVisibility to nobody → B (previously able to see online) now
  // sees offline regardless. Saving fans a filtered `presence.update` to B.
  await page.getByTestId("presence-visibility").selectOption("nobody");
  await page.getByTestId("privacy-save").click();
  await expect(page.getByTestId("privacy-saved")).toBeVisible({ timeout: 10_000 });

  // A nudges presence so the server re-fans the (now `nobody`-filtered) update.
  await page.getByTestId("self-presence-toggle").click();
  await page.getByTestId("set-presence-away").click();

  await expect.poll(() => availabilityOf(b.page, aReg.actor), { timeout: 20_000 }).toBe("offline");

  await b.page.context().close();
});
