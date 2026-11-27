/**
 * `bun run conformance:render`: regenerates CONFORMANCE.md (repo root) from the §12
 * coverage map. `checklist.test.ts` fails while the file is stale.
 */
import { writeFileSync } from "node:fs";
import { CHECKLIST } from "./index.ts";
import { CONFORMANCE_PATH } from "./paths.ts";
import { renderConformance } from "./render.ts";

writeFileSync(CONFORMANCE_PATH, renderConformance(CHECKLIST));
console.log(`wrote ${CONFORMANCE_PATH}`);
