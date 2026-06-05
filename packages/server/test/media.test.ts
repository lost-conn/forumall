/**
 * Media upload + serve tests (spec §5.8).
 *
 * Drives the app in-process via `app.request(...)`. Uploads are signed with the
 * shared `sign()` over the **raw multipart bytes** (the content-digest is taken
 * over exactly those bytes, matching what the §4.5 middleware recomputes). The
 * multipart body is hand-built so the signed bytes and the sent bytes are
 * byte-identical (a `FormData`/`Blob` would re-serialize with its own boundary).
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Attachment,
  AttachmentSchema,
  type AuthBootstrapResponse,
  type Channel,
  type Group,
  type Message,
  MessageSchema,
  contentDigest,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { createMessage } from "../src/provider/messages.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-media-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, overrides: Record<string, string> = {}) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    MEDIA_DIR: join(tmp, `${name}-media`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
    ...overrides,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db });
  return { app, config, db };
}

type App = ReturnType<typeof freshApp>["app"];
type Db = ReturnType<typeof freshApp>["db"];

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}` };
}

const BOUNDARY = "----forumalltestboundary7MA4YWxkTrZu0gW";

/**
 * Hand-build a `multipart/form-data` body with a single `file` part. Returns the
 * exact bytes (so the signed digest matches) and the content-type header.
 */
function buildMultipart(fileBytes: Uint8Array, filename: string, mime: string) {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${BOUNDARY}--\r\n`);
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);
  return { body, contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

/** Upload `fileBytes` as a signed multipart POST /api/media; returns the response. */
async function uploadMedia(
  app: App,
  signer: Signer,
  fileBytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<Response> {
  const path = "/api/media";
  const { body, contentType } = buildMultipart(fileBytes, filename, mime);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method: "POST",
    path,
    body,
  });
  return app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": contentType },
    body,
  });
}

/** A 2x3 (width x height) minimal PNG: signature + IHDR header is enough. */
function fakePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  // PNG signature.
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk length (13) + type "IHDR" (8..15); width/height as BE u32 at 16/20.
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return bytes;
}

async function makeGroupChannel(app: App, signer: Signer) {
  const gRes = await app.request(
    "/api/groups",
    signMethod(signer, "POST", "/api/groups", { name: "G", tier: "public" }),
  );
  expect(gRes.status).toBe(201);
  const group = (await gRes.json()) as Group;
  const cPath = `/api/groups/${group.id}/channels`;
  const cRes = await app.request(
    cPath,
    signMethod(signer, "POST", cPath, { type: "text", tier: "public" }),
  );
  expect(cRes.status).toBe(201);
  const channel = (await cRes.json()) as Channel;
  return { group, channel };
}

function signMethod(signer: Signer, method: string, path: string, bodyObj: unknown) {
  const body = JSON.stringify(bodyObj);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path,
    body,
  });
  return { method, headers: { ...headers, "content-type": "application/json" }, body };
}

// ---------------------------------------------------------------------------

describe("POST /api/media (§5.8)", () => {
  test("uploads a small file → 201 with a schema-valid Attachment", async () => {
    const { app } = freshApp("upload-small");
    const alice = await registerUserWithKey(app, "alice");

    const fileBytes = new TextEncoder().encode("hello, media world");
    const res = await uploadMedia(app, alice, fileBytes, "note.txt", "text/plain");
    expect(res.status).toBe(201);

    const att = (await res.json()) as Attachment;
    expect(() => AttachmentSchema.parse(att)).not.toThrow();
    expect(att.id.startsWith("att_")).toBe(true);
    expect(att.mime).toBe("text/plain");
    expect(att.size).toBe(fileBytes.byteLength);
    expect(att.filename).toBe("note.txt");
    // hash is `sha-256:<base64>` and matches the raw file bytes.
    expect(att.hash?.startsWith("sha-256:")).toBe(true);
    const expectedHash = `sha-256:${contentDigest(fileBytes)}`;
    expect(att.hash).toBe(expectedHash);
    // Non-image: no width/height, still valid.
    expect(att.width).toBeUndefined();
    expect(att.height).toBeUndefined();
    expect(att.url).toBe(`https://${DOMAIN}/api/media/${att.id}`);
  });

  test("the returned url is fetchable and returns the exact bytes", async () => {
    const { app } = freshApp("upload-fetch");
    const alice = await registerUserWithKey(app, "alice");

    const fileBytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const res = await uploadMedia(app, alice, fileBytes, "blob.bin", "application/octet-stream");
    expect(res.status).toBe(201);
    const att = (await res.json()) as Attachment;

    // GET is unauthenticated (capability URL).
    const getRes = await app.request(`/api/media/${att.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("application/octet-stream");
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect([...got]).toEqual([...fileBytes]);
  });

  test("over-limit upload → 413", async () => {
    const { app } = freshApp("upload-toobig", { MAX_UPLOAD_BYTES: "16" });
    const alice = await registerUserWithKey(app, "alice");

    const fileBytes = new TextEncoder().encode("this is definitely more than sixteen bytes");
    const res = await uploadMedia(app, alice, fileBytes, "big.txt", "text/plain");
    expect(res.status).toBe(413);
  });

  test("parses width/height for a PNG", async () => {
    const { app } = freshApp("upload-png");
    const alice = await registerUserWithKey(app, "alice");

    const png = fakePng(1024, 768);
    const res = await uploadMedia(app, alice, png, "diagram.png", "image/png");
    expect(res.status).toBe(201);
    const att = (await res.json()) as Attachment;
    expect(() => AttachmentSchema.parse(att)).not.toThrow();
    expect(att.width).toBe(1024);
    expect(att.height).toBe(768);
  });

  test("unknown media id → 404", async () => {
    const { app } = freshApp("get-404");
    const res = await app.request("/api/media/att_doesnotexist");
    expect(res.status).toBe(404);
  });
});

describe("attachment round-trips through a message (§5.3, §5.8)", () => {
  test("an uploaded Attachment can be referenced in a message and read back", async () => {
    const { app, config, db } = freshApp("attach-msg");
    const alice = await registerUserWithKey(app, "alice");

    // Upload.
    const fileBytes = new TextEncoder().encode("attach me");
    const upRes = await uploadMedia(app, alice, fileBytes, "a.txt", "text/plain");
    expect(upRes.status).toBe(201);
    const att = (await upRes.json()) as Attachment;

    // Group + channel (the creator is already an `owner` member), then seed a
    // message carrying the attachment.
    const { group, channel } = await makeGroupChannel(app, alice);

    const rec = createMessage(db, config, {
      channelId: channel.id,
      groupId: group.id,
      author: alice.actor,
      type: "message",
      content: { text: "see attached", mime: "text/plain" },
      attachments: [att],
    });
    expect(() => MessageSchema.parse(rec.message)).not.toThrow();

    // Read it back via REST history.
    const histPath = `/api/groups/${group.id}/channels/${channel.id}/messages`;
    const histRes = await app.request(histPath, signGet(alice, histPath));
    expect(histRes.status).toBe(200);
    const page = (await histRes.json()) as { items: Message[] };
    const found = page.items.find((m) => m.id === rec.message.id);
    expect(found).toBeDefined();
    expect(() => MessageSchema.parse(found)).not.toThrow();
    expect(found?.attachments?.[0]).toEqual(att);
  });
});

function signGet(signer: Signer, path: string) {
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method: "GET",
    path,
  });
  return { method: "GET", headers };
}
