/**
 * Registration modes and account invites e2e (§4.1.1), single provider.
 *
 * This provider always registers openly, so it never sends the two refusals
 * itself. The tests answer `POST /api/auth/register` and `POST /api/me/claim`
 * with each refusal (a Playwright route) and drive the real forms against them:
 *   1. an invite link (`/register?invite=…`): the page is served with
 *      `Referrer-Policy: no-referrer`, shows the provider it is for, prefills
 *      the token, strips it from the address bar, sends it as `inviteToken`,
 *      and an `invite_required` answer reads as "that token can't be used";
 *   2. without a token: `invite_required` asks for one (and reveals the field),
 *      and `registration_closed` gets its own message;
 *   3. a guest's claim form: the same two refusals, and the token it then asks
 *      for is sent with the claim.
 */
import type { Page, Route } from "@playwright/test";
import { TEST_PASSWORD, registerUser, uniqueHandle } from "../harness/auth.ts";
import { expect, test } from "../harness/fixtures.ts";
import { openAsGuest } from "../harness/groups.ts";

type Refusal = "invite_required" | "registration_closed";

/**
 * Answer each `POST` to `pattern` with the next refusal in `refusals` (the last
 * one repeats) as a §7.3 problem (`403` + `errorCode`), recording the bodies.
 */
async function refuse(
  page: Page,
  pattern: string,
  refusals: Refusal[],
): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const errorCode = refusals[Math.min(bodies.length - 1, refusals.length - 1)];
    await route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: `https://example.invalid/problems/${errorCode}`,
        title: "Forbidden",
        status: 403,
        errorCode,
        detail: "refused",
      }),
    });
  });
  return bodies;
}

async function fillCredentials(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: /handle/i }).fill(uniqueHandle("inv"));
  await page.locator('input[name="password"]').fill(TEST_PASSWORD);
}

test("an invite link: no-referrer page, token prefilled then stripped from the URL, and sent", async ({
  page,
  appServer,
}) => {
  const bodies = await refuse(page, "**/api/auth/register", ["invite_required"]);

  const doc = await page.goto("/register?invite=tok_e2e_invite");
  expect(doc?.headers()["referrer-policy"]).toBe("no-referrer");

  await expect(page.getByTestId("invite-link-notice")).toContainText(`localhost:${appServer.port}`);
  // The token is held by the page, no longer named by its URL.
  await expect(page).toHaveURL(/\/register$/);
  const invite = page.locator('input[name="inviteToken"]');
  await expect(invite).toHaveValue("tok_e2e_invite");

  await fillCredentials(page);
  await page.getByTestId("auth-submit").click();

  // A refused token reads as "that token can't be used", not "you need one".
  // (After a refused token the client first retries as a login, §4.1.1
  // "Retries"; the real provider's Argon2id check of that login takes a while.)
  await expect(page.getByTestId("auth-error")).toContainText("That invite token can't be used", {
    timeout: 15_000,
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.inviteToken).toBe("tok_e2e_invite");
});

test("without a token: invite_required asks for one; registration_closed has its own message", async ({
  page,
}) => {
  const bodies = await refuse(page, "**/api/auth/register", [
    "invite_required",
    "registration_closed",
  ]);

  await page.goto("/");
  await expect(page.getByTestId("credentials-form")).toBeVisible();
  await page.getByTestId("tab-register").click();
  // An open provider does not ask for a token up front.
  await expect(page.locator('input[name="inviteToken"]')).toHaveCount(0);

  await fillCredentials(page);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("auth-error")).toContainText("This provider is invite-only");
  await expect(page.locator('input[name="inviteToken"]')).toBeVisible();
  expect(bodies[0]).not.toHaveProperty("inviteToken");

  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("auth-error")).toContainText(
    "This provider isn't accepting new accounts",
  );
  expect(bodies).toHaveLength(2);
});

test("guest claim: invite_required asks for a token, which is sent; registration_closed explains", async ({
  page,
  browser,
  appServer,
}) => {
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  const { guest, context } = await openAsGuest(page, browser, appServer.baseUrl);
  const bodies = await refuse(guest, "**/api/me/claim", ["invite_required", "registration_closed"]);

  // The guest banner leads to the upgrade panel of settings, with the claim form.
  await guest
    .getByRole("region", { name: "Secure your guest account" })
    .getByRole("button", { name: "Secure account" })
    .click();
  await guest.getByTestId("settings-nav-upgrade").click();
  await expect(guest.getByTestId("claim-form")).toBeVisible({ timeout: 15_000 });
  await guest.getByTestId("claim-handle").fill(uniqueHandle("clm"));
  await guest.getByTestId("claim-password").fill(TEST_PASSWORD);
  await guest.getByTestId("claim-confirm-password").fill(TEST_PASSWORD);
  await guest.getByTestId("claim-submit").click();

  await expect(guest.getByTestId("claim-error")).toContainText("This provider is invite-only");
  expect(bodies[0]).not.toHaveProperty("inviteToken");

  await guest.getByTestId("claim-invite-token").fill("tok_e2e_claim");
  await guest.getByTestId("claim-submit").click();
  await expect(guest.getByTestId("claim-error")).toContainText(
    "a guest account can't be made permanent here",
  );
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.inviteToken).toBe("tok_e2e_claim");

  await context.close();
});
