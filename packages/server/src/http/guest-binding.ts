/**
 * Guest binding (spec §4.8): a guest account is created on the group's provider
 * and **bound to the group it joined**. It therefore never becomes a member of
 * any other group, whichever path it tries: redeeming another group's invite
 * (`POST /api/invites/{token}/redeem`), `POST /api/groups/{groupId}/join`, the
 * channel-join alias (which answers as a group join, §8.2) — which would also
 * file a join request under the `request` policy — or creating a group of its
 * own (`POST /api/groups`, which would make it that group's owner).
 *
 * Each such refusal is `403` `forbidden`, the "provider/group policy forbids"
 * answer §5.6 lists for `/redeem`. Callers check it only after the
 * already-a-member case, so a guest's requests about its own group keep their
 * normal answers (e.g. a `/redeem` of its own group's invite → `200` with its
 * current role).
 *
 * Only a LOCAL actor can be one of our guests: guest accounts are provider-local
 * and never federated (§4.8), so a remote actor (no `localHandle`) is never
 * treated as a guest here.
 */
import type { Db } from "../db/index.ts";
import { getUserRow } from "../provider/guests.ts";
import { AppError } from "./errors.ts";
import type { AuthenticatedActor } from "./types.ts";

/** Whether `actor` is one of this provider's guest accounts (§4.8). */
export function isLocalGuest(db: Db, actor: Pick<AuthenticatedActor, "localHandle">): boolean {
  const handle = actor.localHandle;
  return handle !== undefined && getUserRow(db, handle)?.guest === true;
}

/**
 * Throw `403` when `actor` is a guest: it is bound to the group it joined and
 * may not join, request to join, or create another one (§4.8).
 */
export function refuseGuestOutsideItsGroup(
  db: Db,
  actor: Pick<AuthenticatedActor, "localHandle">,
): void {
  if (isLocalGuest(db, actor)) {
    throw AppError.forbidden({
      detail: "a guest account is bound to the group it joined and cannot join another (§4.8)",
    });
  }
}
