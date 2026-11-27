/**
 * Parses spec §12 ("Compliance Checklist") into its items per level, so the coverage map
 * is compared with the spec itself rather than with hard-coded counts.
 */
import { LEVELS, LEVEL_HEADINGS, type Level } from "./types.ts";

const SECTION_HEADING = /^## 12\.\s/;
const ITEM_PREFIX = "- [ ] ";

/**
 * Returns the `- [ ] …` item texts under each `### …` heading of §12.
 * Throws if §12 is missing, has no items, or has a sub-heading this map does not know,
 * so a restructured checklist fails loudly instead of being silently half-read.
 */
export function parseChecklistSection(specMarkdown: string): Record<Level, string[]> {
  const lines = specMarkdown.split("\n");
  const start = lines.findIndex((l) => SECTION_HEADING.test(l));
  if (start < 0) throw new Error("spec has no '## 12.' section");

  const byHeading = new Map<string, Level>(LEVELS.map((lv) => [LEVEL_HEADINGS[lv], lv]));
  const items = Object.fromEntries(LEVELS.map((lv) => [lv, [] as string[]])) as Record<
    Level,
    string[]
  >;
  let level: Level | undefined;

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      level = byHeading.get(heading);
      if (!level) throw new Error(`unknown §12 sub-heading: ${JSON.stringify(heading)}`);
      continue;
    }
    if (line.startsWith(ITEM_PREFIX)) {
      if (!level) throw new Error(`§12 item before any sub-heading: ${line}`);
      items[level].push(line.slice(ITEM_PREFIX.length).trim());
    }
  }

  if (LEVELS.every((lv) => items[lv].length === 0)) throw new Error("§12 has no items");
  return items;
}
