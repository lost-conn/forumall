/**
 * Direct-message helpers shared by the `dms-*.test.ts` suites (spec §7.4),
 * on top of `ws-harness.ts`.
 */
import { type Booted, type Signer, signedReq } from "./ws-harness.ts";

/** Send a DM from `from` to the conversation `dmId` over the signed send path (§7.4). */
export function sendDm(
  b: Booted,
  from: Signer,
  dmId: string,
  text: string,
  clientMessageId: string,
): Promise<Response> {
  return signedReq(b, from, "POST", `/api/federation/dms/${dmId}/messages`, {
    clientMessageId,
    content: { mime: "text/plain", text },
  });
}
