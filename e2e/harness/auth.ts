/**
 * Programmatic auth helper for e2e specs (P8; P9 reuses this).
 *
 * `registerUser(page, baseURL, handle)` drives the REAL register + in-browser
 * device-key flow through the live SolidJS client and leaves the page
 * authenticated, so each spec can start from a signed-in session quickly without
 * re-typing the onboarding UI. It returns the canonical actor (`handle@host`) the
 * server minted, which callers use to assert membership / role rows.
 *
 * The flow it drives is exactly the one the app uses (connect → register →
 * in-browser keygen → device-key → store), so the private seed lands in
 * IndexedDB and the localStorage session descriptor is written — i.e. a reload
 * stays authenticated. Driving the UI (rather than seeding storage) keeps the
 * helper honest: it exercises the same keygen the product ships.
 */
import type { Page } from "@playwright/test";

/** A unique, schema-valid handle (lowercase alnum, 3–32 chars). */
export function uniqueHandle(prefix = "e2e"): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 32);
}

/** The shared test password (the server only needs >= 8 chars). */
export const TEST_PASSWORD = "correct-horse-battery";

/**
 * Register `handle` on the provider served at `baseURL` and leave `page`
 * authenticated. Returns `{ handle, actor }` where `actor` is `handle@host`.
 *
 * The provider host is the page origin's host (the harness pins the server's
 * §4.4.2 signing authority to `localhost:<port>`), so we just confirm the
 * pre-filled connect form.
 */
export async function registerUser(
  page: Page,
  baseURL: string,
  handle: string = uniqueHandle(),
): Promise<{ handle: string; actor: string }> {
  await page.goto(baseURL);

  // Stage 1: connect (host defaults to the current origin's host).
  await page.getByTestId("connect-form").waitFor({ state: "visible" });
  await page.getByTestId("connect-submit").click();

  // Stage 2: register.
  await page.getByTestId("credentials-form").waitFor({ state: "visible" });
  await page.getByTestId("tab-register").click();
  await page.getByRole("textbox", { name: /handle/i }).fill(handle);
  await page.locator('input[name="password"]').fill(TEST_PASSWORD);
  await page.getByTestId("auth-submit").click();

  // Landed authenticated: the shell shows the actor `handle@host`.
  const host = new URL(baseURL).host;
  const actor = `${handle}@${host}`;
  await page.locator(".app-nav").getByText(actor).waitFor({ state: "visible", timeout: 15_000 });

  return { handle, actor };
}
