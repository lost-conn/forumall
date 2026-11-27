/**
 * §12 Compliance Checklist coverage map (machine-checked).
 *
 * The map lives in `./checklist/*.ts`, one module per area: every §12 item, verbatim,
 * with the test files that assert it, an honest status and a note on what is missing.
 * This suite guards it against rot:
 *  - for each level, the map's items equal the spec's §12 items exactly (§12 is parsed
 *    from the sibling `ofscp` repo's spec at test time, so there are no hard-coded counts),
 *  - every `covered`/`partial` item maps to at least one test, and every mapped file exists,
 *  - every item that is not `covered` has a note, and no `covered` item has one (a gap makes
 *    it `partial`; neutral context goes in `context`),
 *  - CONFORMANCE.md equals the rendered map (`bun run conformance:render` regenerates it).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKLIST } from "./checklist/index.ts";
import { CONFORMANCE_PATH, REPO_ROOT } from "./checklist/paths.ts";
import { countByStatus, levelTitle, renderConformance } from "./checklist/render.ts";
import { parseChecklistSection } from "./checklist/spec-section.ts";
import { LEVELS } from "./checklist/types.ts";
import { OFSCP_REPO } from "./helpers/ofscp-schemas.ts";

const SPEC_PATH = join(OFSCP_REPO, "docs", "ofscp_spec.md");
const SPEC_ITEMS = parseChecklistSection(readFileSync(SPEC_PATH, "utf8"));

describe("§12 Compliance Checklist coverage map", () => {
  for (const level of LEVELS) {
    test(`${level}: the map's items equal the spec's §12 items`, () => {
      const spec = new Set(SPEC_ITEMS[level]);
      const mapped = CHECKLIST.filter((e) => e.level === level).map((e) => e.item);
      const duplicated = mapped.filter((item, i) => mapped.indexOf(item) !== i);
      const notInSpec = mapped.filter((item) => !spec.has(item));
      const notMapped = [...spec].filter((item) => !mapped.includes(item));
      // One object so a mismatch prints the whole diff at once.
      expect({ duplicated, notInSpec, notMapped }).toEqual({
        duplicated: [],
        notInSpec: [],
        notMapped: [],
      });
    });
  }

  test("every covered or partial item maps to at least one test", () => {
    const unmapped = CHECKLIST.filter((e) => e.status !== "missing" && e.covers.length === 0);
    expect(unmapped.map((e) => e.item)).toEqual([]);
  });

  test("every mapped test file exists on disk", () => {
    const missing = CHECKLIST.flatMap((e) => e.covers).filter(
      (f) => !existsSync(join(REPO_ROOT, f)),
    );
    expect([...new Set(missing)]).toEqual([]);
  });

  test("every item that is not covered says what is missing", () => {
    const silent = CHECKLIST.filter((e) => e.status !== "covered" && !e.note?.trim());
    expect(silent.map((e) => e.item)).toEqual([]);
  });

  test("a covered item records no gap", () => {
    const contradicted = CHECKLIST.filter((e) => e.status === "covered" && e.note !== undefined);
    expect(contradicted.map((e) => e.item)).toEqual([]);
  });

  test("CONFORMANCE.md is the rendered map", () => {
    const onDisk = existsSync(CONFORMANCE_PATH) ? readFileSync(CONFORMANCE_PATH, "utf8") : "";
    if (onDisk !== renderConformance(CHECKLIST)) {
      throw new Error("CONFORMANCE.md is stale: run bun run conformance:render");
    }
  });

  test("prints the coverage summary", () => {
    const lines = LEVELS.map((level) => {
      const ofLevel = CHECKLIST.filter((e) => e.level === level);
      const c = countByStatus(ofLevel);
      return `  ${levelTitle(level)}: ${ofLevel.length} items, ${c.covered} covered, ${c.partial} partial, ${c.missing} missing`;
    });
    console.log(`\n§12 coverage:\n${lines.join("\n")}\n`);
    expect(lines).toHaveLength(LEVELS.length);
  });
});
