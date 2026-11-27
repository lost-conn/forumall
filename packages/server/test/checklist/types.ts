/**
 * Types shared by the §12 coverage-map modules (`packages/server/test/checklist/*`).
 */

/** The five §12 checklist lists, in spec order. */
export const LEVELS = [
  "provider-must",
  "provider-should",
  "provider-may",
  "client-must",
  "client-should",
] as const;

export type Level = (typeof LEVELS)[number];

/** The `### …` heading that introduces each level's list in spec §12. */
export const LEVEL_HEADINGS: Readonly<Record<Level, string>> = {
  "provider-must": "Provider **MUST**",
  "provider-should": "Provider **SHOULD**",
  "provider-may": "Provider **MAY** (optional)",
  "client-must": "Client **MUST**",
  "client-should": "Client **SHOULD**",
};

/**
 * Honest coverage status.
 * - `covered`: every part of the item has behaviour and an asserting test.
 * - `partial`: some asserting test exists, but part of the behaviour or its tests is missing.
 * - `missing`: no test asserts the item at all (its `covers` may be empty).
 */
export type Status = "covered" | "partial" | "missing";

export const STATUSES: readonly Status[] = ["covered", "partial", "missing"];

export interface ChecklistEntry {
  /** Verbatim §12 item text (markdown backticks preserved). */
  readonly item: string;
  readonly level: Level;
  /** Repo-relative test files that assert the item. Non-empty unless `missing`. */
  readonly covers: readonly string[];
  readonly status: Status;
  /** What is missing, in a sentence or two. Required unless `covered`. */
  readonly note?: string;
}
