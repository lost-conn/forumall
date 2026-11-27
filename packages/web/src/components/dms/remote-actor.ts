import { isLocalActor } from "../../lib/federation.ts";
import { session } from "../../stores/session.ts";

/**
 * Whether `actor` lives on a different provider than the signed-in user (the
 * DM views mark such avatars as federated).
 */
export function isRemoteActor(actor: string): boolean {
  const home = session.host;
  if (!home || !actor) return false;
  return !isLocalActor(actor, home);
}
