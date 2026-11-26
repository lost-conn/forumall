/**
 * Resolving a user reference to a user this provider hosts. Shared by the REST
 * `/api/users/{userRef}/…` routes (§6.1) and the WS `presence.subscribe`
 * command (§7.5), which refuses exactly the subjects those routes answer `404`.
 */
import { canonicalAuthority } from "@forumall/shared";
import type { Db } from "../db/index.ts";
import { getUserRow } from "./guests.ts";

/**
 * Resolve a `userRef` — `handle`, `handle@domain`, or the canonical HTTPS URI
 * `https://{domain}/api/users/{handle}` — to the LOCAL handle of a user this
 * provider (canonical authority `host`) hosts, or `null`: a foreign domain, a
 * malformed reference, or no such local user.
 */
export function localHandleOfUserRef(db: Db, host: string, ref: string): string | null {
  let handle = ref;
  if (ref.startsWith("https://")) {
    // https://{domain}/api/users/{handle}
    try {
      const u = new URL(ref);
      if (canonicalAuthority(u.host) !== host) return null;
      const m = u.pathname.match(/\/api\/users\/([^/]+)$/);
      if (!m) return null;
      handle = decodeURIComponent(m[1] as string);
    } catch {
      return null;
    }
  } else {
    const at = ref.lastIndexOf("@");
    if (at > 0 && at < ref.length - 1) {
      if (canonicalAuthority(ref.slice(at + 1)) !== host) return null; // foreign domain
      handle = ref.slice(0, at);
    }
    // else: bare handle — treat as local.
  }

  return getUserRow(db, handle) ? handle : null;
}
