import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (P8). The base URL is supplied per-test by the harness
 * fixture (it boots an ephemeral provider and overrides `baseURL`), so no global
 * `webServer` is configured here.
 *
 * Browser: this environment's OS is newer than the bundled Playwright supports,
 * so the downloadable chromium build is unavailable. We instead drive the
 * system-installed Google Chrome via the `chrome` channel (override with
 * PW_CHANNEL if a different channel is available).
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PW_CHANNEL ?? "chrome",
      },
    },
  ],
});
