/**
 * Upload targets across two providers (spec §5.8, §7.4, §8.3).
 *
 * bob on provider B uploads to his home provider naming A as the `target`: a
 * **remote upload**. A, which holds the DM bob sends alice, does not host the
 * file, so it checks only what §5.8 asks of a remote author's attachment
 * (`https` `url` and `thumbnail.url`, no nested thumbnail, no `expiresAt`
 * kept) and stores it. B, asked to hold a message with that same upload,
 * refuses it: it is not a local upload there. The single-provider half is
 * `media-target.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Attachment,
  AttachmentSchema,
  type AuthBootstrapResponse,
  type Message,
  deriveDmId,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { at } from "./helpers/at.ts";
import { SAMPLES, pngHeader } from "./helpers/media-samples.ts";
import { type UploadSigner, uploadMedia } from "./helpers/media-upload.ts";
import { type Federation, type Provider, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
let fed: Federation;
let alice: UploadSigner;
let bob: UploadSigner;
let carol: UploadSigner;

/** Register `handle` on `p` with a device key. */
async function register(p: Provider, handle: string): Promise<UploadSigner> {
  const reg = await p.app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const { bootstrap_token } = (await reg.json()) as AuthBootstrapResponse;
  const keypair = generateKeyPair();
  const dk = await p.app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bootstrap_token}` },
    body: JSON.stringify({ public_key: keypair.publicKey, algorithm: "Ed25519", device_name: "d" }),
  });
  expect(dk.status).toBe(201);
  const { key_id } = (await dk.json()) as { key_id: string };
  return { keyId: key_id, privateKey: keypair.privateKey, actor: `${handle}@${p.domain}` };
}

/** POST `bodyObj` to `p` as `signer`, signed for `p`'s authority. */
function postTo(p: Provider, signer: UploadSigner, path: string, bodyObj: unknown) {
  const body = JSON.stringify(bodyObj);
  const { headers } = sign({ ...signer, authority: p.domain, method: "POST", path, body });
  return fetch(`${p.base}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
  });
}

/** bob's upload at B (his home provider), for `target`, with a poster thumbnail. */
async function bobUpload(target: string): Promise<Attachment> {
  const res = await uploadMedia(
    { request: (path, init) => fetch(`${fed.b.base}${path}`, init) },
    bob,
    SAMPLES.mp4?.bytes ?? new Uint8Array(),
    "clip.mp4",
    "video/mp4",
    [["target", target]],
    [{ name: "thumbnail", filename: "poster.png", mime: "image/png", bytes: pngHeader(16, 9) }],
  );
  expect(res.status).toBe(201);
  return AttachmentSchema.parse(await res.json());
}

/** bob sends a DM carrying `attachments` to `to`, delivered at `to`'s provider `p`. */
function bobDm(p: Provider, to: UploadSigner, key: string, attachments: unknown[]) {
  const dmId = deriveDmId(bob.actor, to.actor);
  return postTo(p, bob, `/api/federation/dms/${dmId}/messages`, {
    clientMessageId: key,
    content: { mime: "text/plain", text: "a clip" },
    attachments,
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-media-target-fed-"));
  fed = startFederation(tmp);
  alice = await register(fed.a, "alice");
  bob = await register(fed.b, "bob");
  carol = await register(fed.b, "carol");
});
afterAll(() => {
  fed.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("a remote upload in a DM to its target provider (§5.8, §8.3)", () => {
  test("A stores B's attachment as sent, with a stable url and no expiresAt", async () => {
    const att = await bobUpload(fed.a.domain);
    expect(att.url.startsWith(`https://${fed.b.domain}/`)).toBe(true);
    expect(att.expiresAt).toBeUndefined();

    const res = await bobDm(fed.a, alice, "k_remote", [att]);
    expect(res.status).toBe(201);
    expect(at(((await res.json()) as Message).attachments ?? [], 0)).toEqual(att);
  });

  test("B refuses that upload in a message it holds itself: it is not a local upload there", async () => {
    const att = await bobUpload(fed.a.domain);
    const res = await bobDm(fed.b, carol, "k_wrong_target", [att]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail?: string }).detail).toContain("remote upload");

    // Uploaded again for B (its own target), it posts there.
    const local = await bobUpload(fed.b.domain);
    expect((await bobDm(fed.b, carol, "k_local", [local])).status).toBe(201);
  });
});

describe("checks on a remote author's attachment (§5.8)", () => {
  const external: Attachment = {
    id: "att_ext",
    mime: "video/mp4",
    url: "https://cdn.b.test/m/v.mp4",
    size: 100,
    thumbnail: { id: "att_poster", mime: "image/png", url: "https://cdn.b.test/m/p.png", size: 9 },
  };

  test("a non-https url or thumbnail.url, or a nested thumbnail, is 400", async () => {
    const thumb = external.thumbnail ?? { id: "", mime: "", url: "", size: 0 };
    for (const [key, attachment] of [
      ["k_http_url", { ...external, url: "http://cdn.b.test/m/v.mp4" }],
      ["k_http_thumb", { ...external, thumbnail: { ...thumb, url: "http://cdn.b.test/m/p.png" } }],
      ["k_nested", { ...external, thumbnail: { ...thumb, thumbnail: thumb } }],
    ] as const) {
      const res = await bobDm(fed.a, alice, key, [attachment]);
      expect({ key, status: res.status }).toEqual({ key, status: 400 });
    }
  });

  test("an https attachment is stored without the author's expiresAt", async () => {
    const thumb = external.thumbnail ?? { id: "", mime: "", url: "", size: 0 };
    const res = await bobDm(fed.a, alice, "k_expires", [
      {
        ...external,
        expiresAt: "2099-01-01T00:00:00Z",
        thumbnail: { ...thumb, expiresAt: "2099-01-01T00:00:00Z" },
      },
    ]);
    expect(res.status).toBe(201);
    expect(at(((await res.json()) as Message).attachments ?? [], 0)).toEqual(external);
  });
});
