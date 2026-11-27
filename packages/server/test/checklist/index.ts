/**
 * The §12 Compliance Checklist coverage map: every item of spec §12, mapped to the tests
 * that assert it, with an honest status. One module per area so changes to different
 * areas do not conflict. `checklist.test.ts` checks it against the spec and against
 * CONFORMANCE.md, which is rendered from it (`bun run conformance:render`).
 */
import { AUTH_SIGNING } from "./auth-signing.ts";
import { CLIENT } from "./client.ts";
import { GROUPS_MESSAGES } from "./groups-messages.ts";
import { MEDIA_USERS } from "./media-users.ts";
import { PROVIDER_OPTIONAL } from "./provider-optional.ts";
import { REALTIME_FEDERATION } from "./realtime-federation.ts";
import type { ChecklistEntry } from "./types.ts";

export const CHECKLIST: readonly ChecklistEntry[] = [
  ...AUTH_SIGNING,
  ...GROUPS_MESSAGES,
  ...MEDIA_USERS,
  ...REALTIME_FEDERATION,
  ...PROVIDER_OPTIONAL,
  ...CLIENT,
];
