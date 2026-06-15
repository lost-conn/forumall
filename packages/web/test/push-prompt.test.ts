/**
 * Pure-function coverage for the first-load push nudge visibility predicate.
 * `shouldShowPushPrompt` is DOM-free, so this runs in Bun without a browser env.
 * The banner shows iff: push supported + permission 'default' + push not already
 * enabled + not previously dismissed. Each negative condition must flip it off.
 */
import { describe, expect, test } from "bun:test";
import { shouldShowPushPrompt } from "../src/lib/push.ts";

const SHOWABLE = {
  supported: true,
  permission: "default" as NotificationPermission,
  enabledPref: false,
  dismissed: false,
};

describe("shouldShowPushPrompt", () => {
  test("supported + default + not-enabled + not-dismissed → true", () => {
    expect(shouldShowPushPrompt(SHOWABLE)).toBe(true);
  });

  test("unsupported → false", () => {
    expect(shouldShowPushPrompt({ ...SHOWABLE, supported: false })).toBe(false);
  });

  test("permission 'granted' → false", () => {
    expect(shouldShowPushPrompt({ ...SHOWABLE, permission: "granted" })).toBe(false);
  });

  test("permission 'denied' → false", () => {
    expect(shouldShowPushPrompt({ ...SHOWABLE, permission: "denied" })).toBe(false);
  });

  test("already enabled → false", () => {
    expect(shouldShowPushPrompt({ ...SHOWABLE, enabledPref: true })).toBe(false);
  });

  test("previously dismissed → false", () => {
    expect(shouldShowPushPrompt({ ...SHOWABLE, dismissed: true })).toBe(false);
  });
});
