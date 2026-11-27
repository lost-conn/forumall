/** Paths the coverage map is checked against and rendered to. */
import { join } from "node:path";

/** Repo root: this file is packages/server/test/checklist → up 4. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

export const CONFORMANCE_PATH = join(REPO_ROOT, "CONFORMANCE.md");
