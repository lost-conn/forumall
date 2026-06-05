import { expect, test } from "bun:test";
import { OFSCP_VERSION } from "../src/index.ts";

test("exports OFSCP_VERSION", () => {
  expect(OFSCP_VERSION).toBe("0.1.0");
});
