/**
 * Signed requests against one provider of a two-provider federation
 * (`helpers/two-provider.ts`), addressed by its localhost `base` and signed for
 * its logical `authority` (§4.4.2: the authority is the provider's domain, not
 * the transport host).
 */
import { expect } from "bun:test";
import { type AuthBootstrapResponse, generateKeyPair, sign } from "@forumall/shared";

/** A user registered on one provider, with a device key. */
export interface RemoteSigner {
  readonly keyId: string;
  readonly privateKey: string;
  readonly actor: string;
}

/** Register `handle` on the provider at `base` (domain `domain`) with a device key. */
export async function registerAt(
  base: string,
  domain: string,
  handle: string,
): Promise<RemoteSigner> {
  const reg = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await fetch(`${base}/api/auth/device-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${domain}` };
}

/** A request signed by `signer` for `authority`, sent to the provider at `base`. */
export function signedReqAt(
  base: string,
  authority: string,
  signer: RemoteSigner,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}
