/** Which provider a DM is delivered through (§7.4). */
import { clientForHost, domainOf, isLocalActor } from "../../lib/federation.ts";
import { keyStore } from "../../lib/key-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import { session } from "../../stores/session.ts";

/**
 * Resolve the client a DM to `counterparty` is delivered through (§7.4): the home
 * client for a same-provider recipient, or a per-host client targeting the
 * recipient's domain for a CROSS-PROVIDER DM (signed by the home key; the
 * recipient's provider resolves it via §4.6). Returns `null` if the session has
 * no signing identity (the caller falls back to the home client).
 */
export async function resolveDeliveryClient(counterparty: string): Promise<OfscpClient | null> {
  const home = session.host;
  const actor = session.actor;
  const keyId = session.keyId;
  if (!home || !actor || !keyId) return null;
  if (isLocalActor(counterparty, home)) return null; // same provider → home client
  const targetHost = domainOf(counterparty);
  if (!targetHost) return null;
  const privateKey = await keyStore.getKey(keyId);
  if (!privateKey) return null;
  return clientForHost(targetHost, { actor, keyId, privateKey });
}
