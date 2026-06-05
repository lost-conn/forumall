/**
 * The shared visibility resolver (spec §6.1) — the reusable core that the
 * profile, membership-listing, and (later) presence endpoints all gate on.
 *
 * {@link canView} answers a single question: "may this viewer see this piece of
 * the subject's data, given the subject's policy for it?". It is **total** and
 * **side-effect-free** (it only reads `group_members` / `contacts` rows), so it
 * is safe to call from any read path.
 *
 * ## The §6.1 enum
 *  - `public` — visible to anyone, even an unauthenticated viewer.
 *  - `authenticated` — visible to any authenticated viewer.
 *  - `sharedGroups` — visible to a viewer who shares ≥1 group with the subject.
 *  - `contacts` — visible to a viewer the subject holds an accepted contact for.
 *  - `nobody` — visible to no one but the subject themselves.
 *
 * ## Precedence (documented, load-bearing)
 * The decision is computed in this fixed order; the **first** rule that applies
 * wins:
 *
 *  1. **Self** — the subject viewing themselves is ALWAYS visible (even under
 *     `nobody`). Resolved up front.
 *  2. **denyList** — if the viewer's actor is in `denyList`, the answer is
 *     `false`. Deny always wins over allow and over the policy.
 *  3. **allowList** — if the viewer's actor is in `allowList`, the answer is
 *     `true` (overriding the base policy, but never overriding a deny above).
 *  4. **policy** — otherwise apply the §6.1 enum value.
 *
 * The subject is always a LOCAL user of this provider (identified by
 * `subjectHandle` + `subjectDomain`); the viewer MAY be local, remote, or
 * `null` (unauthenticated).
 */
import type { Db } from "../db/index.ts";
import { areContacts } from "./contacts.ts";
import { sharesGroupWith } from "./membership.ts";

/** The §6.1 visibility enum. Kept in sync with the shared `VisibilityPolicy`. */
export type VisibilityPolicyValue =
  | "public"
  | "authenticated"
  | "sharedGroups"
  | "contacts"
  | "nobody";

/** The authenticated viewer's identity, or `null` for an unauthenticated viewer. */
export interface ViewerActor {
  /** Full actor identifier (`handle@domain`). */
  readonly actor: string;
  /** Local handle for a local viewer; empty string for a remote/provider identity. */
  readonly handle: string;
  /** Canonicalized authority/domain the viewer belongs to. */
  readonly domain: string;
}

/** Inputs to {@link canView}. */
export interface CanViewInput {
  /** The LOCAL subject's handle (the data owner). */
  readonly subjectHandle: string;
  /** The LOCAL subject's canonicalized domain (this provider's host). */
  readonly subjectDomain: string;
  /** The viewing actor, or `null` if the request is unauthenticated. */
  readonly viewerActor: ViewerActor | null;
  /** The §6.1 policy governing the data being requested. */
  readonly policy: VisibilityPolicyValue;
  /** Actors that always pass (overrides the policy; loses to `denyList`). */
  readonly allowList?: readonly string[];
  /** Actors that never pass (overrides both `allowList` and the policy). */
  readonly denyList?: readonly string[];
}

/**
 * Decide whether `viewerActor` may see the subject's data under `policy`, with
 * `allowList`/`denyList` overrides. See the file header for the full precedence.
 * Total and side-effect-free.
 */
export function canView(db: Db, input: CanViewInput): boolean {
  const { subjectHandle, subjectDomain, viewerActor, policy, allowList, denyList } = input;
  const subjectActor = `${subjectHandle}@${subjectDomain}`;

  // 1. Self is always visible (even under `nobody`).
  if (viewerActor && viewerActor.actor === subjectActor) return true;

  // 2/3. allow/deny overrides — only meaningful for an identified viewer.
  if (viewerActor) {
    if (denyList?.includes(viewerActor.actor)) return false; // deny wins
    if (allowList?.includes(viewerActor.actor)) return true; // then allow
  }

  // 4. The base §6.1 policy.
  switch (policy) {
    case "public":
      return true;
    case "authenticated":
      return viewerActor !== null;
    case "sharedGroups":
      return viewerActor !== null && sharesGroupWith(db, subjectActor, viewerActor.actor);
    case "contacts":
      return viewerActor !== null && areContacts(db, subjectHandle, viewerActor.actor);
    case "nobody":
      // Only the subject (handled in step 1) may see `nobody` data.
      return false;
    default:
      // Unknown policy → fail closed (total over the type via the enum, but keep
      // a defensive default for forward-compat with provider-defined values).
      return false;
  }
}
