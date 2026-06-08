/**
 * Mobile responsiveness (~390px). The group/channel and DM pages are
 * master-detail on small screens: only the list OR the detail shows at a time,
 * with a back control to return to the list. Message actions (reply/edit/react)
 * are always visible on touch rather than hover-revealed.
 */
import type { Page } from "@playwright/test";
import { registerUser, uniqueHandle } from "../harness/auth.ts";
import { expect, test } from "../harness/fixtures.ts";

const MOBILE = { width: 390, height: 800 };

async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByTestId("open-create-group").click();
  await page.getByTestId("create-group-modal").waitFor({ state: "visible" });
  await page.getByTestId("group-name").fill(name);
  await page.getByTestId("group-tier").selectOption("public");
  await page.getByTestId("join-policy-open").click();
  await page.getByTestId("create-group-submit").click();
  await page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15_000 });
  await page.getByTestId("group-name-heading").waitFor({ state: "visible" });
}

async function createChannel(page: Page, name: string): Promise<void> {
  await page.getByTestId("open-create-channel").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "visible" });
  await page.getByTestId("channel-name").fill(name);
  await page.getByTestId("channel-tier").selectOption("public");
  await page.getByTestId("create-channel-submit").click();
  await page.getByTestId("create-channel-modal").waitFor({ state: "hidden" });
  await page
    .locator(`[data-testid="channel-row"][data-channel-name="${name}"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
}

test("mobile: group page is master-detail; message actions are visible on touch", async ({
  page,
  appServer,
}) => {
  // Register at desktop width (the registration helper waits on the desktop
  // space rail), then shrink to a phone viewport for the responsive assertions.
  await registerUser(page, appServer.baseUrl, uniqueHandle());
  await page.setViewportSize(MOBILE);
  await page.goto("/groups");
  await createGroup(page, `M ${Date.now().toString(36)}`);
  await createChannel(page, "general");

  // Opening a channel switches to the chat pane; the channel list is hidden.
  await page
    .locator('[data-testid="channel-row"][data-channel-name="general"]')
    .getByTestId("open-channel")
    .click();
  await expect(page.getByTestId("chat-view")).toBeVisible();
  await expect(page.getByTestId("channels-list")).toBeHidden();
  await expect(page.getByTestId("mobile-back-to-channels")).toBeVisible();

  // Post a message; its Reply action is actually visible (opacity 1) without hover.
  const input = page.getByTestId("composer-input");
  await input.fill("hi from mobile");
  await input.press("Enter");
  const reply = page
    .locator('[data-testid="message-row"]')
    .filter({ hasText: "hi from mobile" })
    .first()
    .getByTestId("reply-button");
  await expect(reply).toBeVisible();
  const opacity = await reply.evaluate(
    (el) => getComputedStyle(el.parentElement as Element).opacity,
  );
  expect(opacity).toBe("1");

  // Back returns to the channel list; the chat pane is hidden.
  await page.getByTestId("mobile-back-to-channels").click();
  await expect(page.getByTestId("channels-list")).toBeVisible();
  await expect(page.getByTestId("chat-view")).toBeHidden();
});
