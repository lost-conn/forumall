/**
 * Pure-function coverage for the profile settings form's save payload (§6.3):
 * `avatar` is sent only when it changed, an emptied field is `null`, and a
 * non-https avatar is refused client-side.
 */
import { describe, expect, test } from "bun:test";
import { profileUpdateBody } from "../src/lib/profile-form.ts";

const LEGACY = "https://cdn.example/old.png";
const fields = (avatar: string) => ({ displayName: " Alice ", avatar, bio: " hi " });

describe("profileUpdateBody", () => {
  test("an unchanged avatar (even an external one) is not sent", () => {
    expect(profileUpdateBody(fields(LEGACY), LEGACY)).toEqual({
      body: { displayName: "Alice", bio: "hi" },
    });
    expect(profileUpdateBody(fields(` ${LEGACY} `), LEGACY)).toEqual({
      body: { displayName: "Alice", bio: "hi" },
    });
  });

  test("no avatar before or after: not sent", () => {
    expect(profileUpdateBody(fields(""), null)).toEqual({
      body: { displayName: "Alice", bio: "hi" },
    });
  });

  test("a changed avatar is sent", () => {
    const url = "https://providera.test/api/media/att_1";
    expect(profileUpdateBody(fields(url), LEGACY)).toEqual({
      body: { displayName: "Alice", bio: "hi", avatar: url },
    });
    expect(profileUpdateBody(fields(url), null)).toEqual({
      body: { displayName: "Alice", bio: "hi", avatar: url },
    });
  });

  test("clearing the avatar sends null", () => {
    expect(profileUpdateBody(fields("  "), LEGACY)).toEqual({
      body: { displayName: "Alice", bio: "hi", avatar: null },
    });
  });

  test("a changed non-https avatar is an error", () => {
    expect(profileUpdateBody(fields("http://cdn.example/a.png"), null)).toEqual({
      error: "Avatar must be an https:// URL.",
    });
  });
});
