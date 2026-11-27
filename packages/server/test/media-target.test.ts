/**
 * `POST /api/media` beyond the bytes (spec §5.8): the upload's `target`, the
 * uploader's `thumbnail` part, the guarded `mime`, and what they mean for a
 * message (only a local upload is accepted, stored with the provider's own
 * thumbnail record), for an avatar (§6.3: a remote upload is refused) and for
 * a remote upload's `url` (stable, no `expiresAt`).
 *
 * The two-provider half (a remote upload used where it is meant to be, in a DM
 * to its target provider, and a remote author's non-`https` thumbnail) is in
 * `media-target-federation.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Attachment, AttachmentSchema, type Message } from "@forumall/shared";

import { openDb } from "../src/db/index.ts";
import { migrate, migrations, runMigrations } from "../src/db/migrate.ts";
import { getMediaRow } from "../src/provider/media.ts";
import { at } from "./helpers/at.ts";
import { SAMPLES, SCRIPT_BYTES, onePixelPng, pngHeader } from "./helpers/media-samples.ts";
import { type FilePart, type FormFields, uploadMedia } from "./helpers/media-upload.ts";
import { makeOfscpCompiler } from "./helpers/ofscp-schemas.ts";
import {
  type Booted,
  DOMAIN,
  type Signer,
  boot as bootIn,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-media-target-"));
});
afterAll(() => {
  for (const b of booted) b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

function boot(name: string, env: Record<string, string> = {}): Booted {
  const b = bootIn(tmp, name, env);
  booted.push(b);
  return b;
}

const compile = makeOfscpCompiler();

async function expectValid(schemaFile: string, body: unknown): Promise<void> {
  const validate = await compile(schemaFile);
  const ok = validate(body);
  expect({ schemaFile, ok, errors: ok ? undefined : validate.errors }).toEqual({
    schemaFile,
    ok: true,
    errors: undefined,
  });
}

const thumbPart = (
  bytes: Uint8Array = pngHeader(32, 18),
  mime = "image/png",
  filename = "poster.png",
): FilePart => ({ name: "thumbnail", filename, mime, bytes });

async function upload(
  b: Booted,
  who: Signer,
  opts: {
    fields?: FormFields;
    files?: readonly FilePart[];
    bytes?: Uint8Array;
    mime?: string;
  } = {},
): Promise<Response> {
  return uploadMedia(
    b.app,
    who,
    opts.bytes ?? SAMPLES.mp4?.bytes ?? new Uint8Array(),
    "clip.mp4",
    opts.mime ?? "video/mp4",
    opts.fields ?? [],
    opts.files ?? [],
  );
}

async function uploaded(b: Booted, who: Signer, opts: Parameters<typeof upload>[2] = {}) {
  const res = await upload(b, who, opts);
  expect(res.status).toBe(201);
  return AttachmentSchema.parse(await res.json());
}

describe("upload target (§5.8 Target)", () => {
  test("omitted or naming this provider (any spelling) is a local upload", async () => {
    const b = boot("target-local");
    const alice = await registerUserWithKey(b, "alice");
    for (const fields of [[], [["target", DOMAIN]], [["target", "ProviderA.TEST:443"]]] as const) {
      const att = await uploaded(b, alice, { fields });
      expect(getMediaRow(b.db, att.id)?.target).toBeNull();
    }
  });

  test("another provider is recorded in canonical form; it is not part of the Attachment", async () => {
    const b = boot("target-remote");
    const alice = await registerUserWithKey(b, "alice");
    const res = await upload(b, alice, { fields: [["target", "Other.Example.:443"]] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect("target" in body).toBe(false);
    expect(getMediaRow(b.db, String(body.id))?.target).toBe("other.example");
  });

  test("a target that is not a valid authority, or sent twice, is 400", async () => {
    const b = boot("target-invalid");
    const alice = await registerUserWithKey(b, "alice");
    for (const fields of [
      [["target", ""]],
      [["target", "a b.test"]],
      [["target", "x@other.test"]],
      [["target", "other.test/path"]],
      [["target", "other.test:99999"]],
      [["target", "https://other.test"]],
      [
        ["target", "other.test"],
        ["target", "third.test"],
      ],
    ] as const) {
      const res = await upload(b, alice, { fields });
      expect({ fields, status: res.status }).toEqual({ fields, status: 400 });
    }
  });
});

describe("thumbnail part (§5.8 Thumbnail)", () => {
  test("is stored as its own upload and returned as `thumbnail`, sharing the target", async () => {
    const b = boot("thumb-ok");
    const alice = await registerUserWithKey(b, "alice");
    const poster = pngHeader(32, 18);
    const att = await uploaded(b, alice, {
      fields: [["target", "other.test"]],
      files: [thumbPart(poster)],
    });
    await expectValid("attachment.json", att);
    const thumb = att.thumbnail;
    expect(thumb).toMatchObject({ mime: "image/png", size: poster.length, width: 32, height: 18 });
    expect(thumb?.filename).toBe("poster.png");
    expect(thumb?.id).not.toBe(att.id);
    expect(thumb && "thumbnail" in thumb).toBe(false);

    // Fetchable like any upload, with the poster's bytes.
    const res = await b.app.request(new URL(thumb?.url ?? "").pathname);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(poster);

    // Same owner and target as its parent.
    const row = getMediaRow(b.db, thumb?.id ?? "");
    expect(row).toMatchObject({ owner: alice.actor, target: "other.test", thumbnailId: null });
    expect(getMediaRow(b.db, att.id)?.thumbnailId).toBe(thumb?.id ?? "");
  });

  test("a thumbnail that is not a confirmed image is 400; over the size limit, 413; nothing is stored", async () => {
    const b = boot("thumb-refused", { MAX_UPLOAD_BYTES: "4096" });
    const alice = await registerUserWithKey(b, "alice");
    const count = () =>
      b.db.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media").get()?.n;
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const [part, status] of [
      [thumbPart(new TextEncoder().encode("hi"), "text/plain", "a.txt"), 400],
      // An image type its bytes do not confirm is recorded as octet-stream: not an image.
      [thumbPart(SCRIPT_BYTES, "image/png"), 400],
      // SVG is recorded as declared but never confirmed by bytes or shown inline.
      [thumbPart(svg, "image/svg+xml", "poster.svg"), 400],
      [thumbPart(new Uint8Array(4097).fill(0x41), "image/png"), 413],
    ] as const) {
      const res = await upload(b, alice, { files: [part] });
      expect({ mime: part.mime, status: res.status }).toEqual({ mime: part.mime, status });
    }
    // A text part named `thumbnail`, or two thumbnails, are malformed.
    const twice = await upload(b, alice, { files: [thumbPart(), thumbPart()] });
    expect(twice.status).toBe(400);
    const textPart = await upload(b, alice, { fields: [["thumbnail", "x"]] });
    expect(textPart.status).toBe(400);
    expect(count()).toBe(0);
  });

  test("a file and a thumbnail each up to the limit fit, though together they exceed it", async () => {
    const limit = 2048; // above the sample MP4's size
    const b = boot("thumb-sizes", { MAX_UPLOAD_BYTES: String(limit) });
    const alice = await registerUserWithKey(b, "alice");
    const file = new Uint8Array(limit);
    file.set(SAMPLES.mp4?.bytes ?? [], 0);
    const poster = new Uint8Array(limit);
    poster.set(pngHeader(4, 4), 0);
    const att = await uploaded(b, alice, { bytes: file, files: [thumbPart(poster)] });
    expect([att.size, att.thumbnail?.size]).toEqual([limit, limit]);
  });
});

describe("mime guard (§5.8 POST /api/media)", () => {
  test("an inline type is recorded only when the bytes confirm it", async () => {
    const b = boot("mime-guard");
    const alice = await registerUserWithKey(b, "alice");
    const cases: readonly (readonly [Uint8Array, string, string])[] = [
      [onePixelPng(), "image/png", "image/png"],
      [SCRIPT_BYTES, "image/png", "application/octet-stream"],
      [SCRIPT_BYTES, "video/mp4", "application/octet-stream"],
      [pngHeader(1, 1), "audio/mpeg", "application/octet-stream"],
      [SAMPLES.webm?.bytes ?? new Uint8Array(), "audio/webm", "audio/webm"],
      [SCRIPT_BYTES, "text/html", "text/html"],
      [SCRIPT_BYTES, "image/svg+xml", "image/svg+xml"],
      // No declared type: what the bytes are (Bun's parser guesses from the
      // filename, and that guess is held to the same rule).
      [onePixelPng(), "", "image/png"],
    ];
    for (const [bytes, declared, recorded] of cases) {
      const att = await uploaded(b, alice, { bytes, mime: declared });
      expect({ declared, mime: att.mime }).toEqual({ declared, mime: recorded });
      // Served with the recorded type, so a refused inline type downloads.
      const res = await b.app.request(new URL(att.url).pathname);
      expect(res.headers.get("content-type")).toBe(recorded);
      if (recorded === "application/octet-stream") {
        expect(res.headers.get("content-disposition")).toStartWith("attachment");
      }
    }
  });
});

describe("attachments in a message: only local uploads (§5.8 Checks)", () => {
  test("a local upload posts and is stored with the provider's thumbnail record", async () => {
    const b = boot("msg-local");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const path = `/api/groups/${groupId}/channels/${channelId}/messages`;
    const att = await uploaded(b, alice, { files: [thumbPart()] });
    const thumb = att.thumbnail;
    if (thumb === undefined) throw new Error("upload returned no thumbnail");

    // The client's copy of the thumbnail's optional fields is not what is stored.
    const forged = { ...att, thumbnail: { ...thumb, width: 9999, filename: "evil.png" } };
    const res = await signedReq(b, alice, "POST", path, {
      clientMessageId: "c_local",
      type: "message",
      content: { mime: "text/plain", text: "see poster" },
      attachments: [forged],
    });
    expect(res.status).toBe(201);
    expect(at(((await res.json()) as Message).attachments ?? [], 0)).toEqual(att);
  });

  test("a remote upload is refused in a message this provider holds", async () => {
    const b = boot("msg-remote");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const path = `/api/groups/${groupId}/channels/${channelId}/messages`;
    const remote = await uploaded(b, alice, { fields: [["target", "other.test"]] });
    const res = await signedReq(b, alice, "POST", path, {
      clientMessageId: "c_remote",
      type: "message",
      content: { mime: "text/plain", text: "x" },
      attachments: [remote],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail?: string }).detail).toContain("remote upload");

    // Its thumbnail shares the target, so it is a remote upload too.
    const withThumb = await uploaded(b, alice, {
      fields: [["target", "other.test"]],
      files: [thumbPart()],
    });
    const thumbAlone = await signedReq(b, alice, "POST", path, {
      clientMessageId: "c_remote_thumb",
      type: "message",
      content: { mime: "text/plain", text: "x" },
      attachments: [withThumb.thumbnail],
    });
    expect(thumbAlone.status).toBe(400);
  });
});

describe("remote uploads keep a stable url (§5.8 Revocation)", () => {
  test("no expiresAt, on it or its thumbnail, and it stays fetchable unreferenced", async () => {
    const b = boot("remote-stable");
    const alice = await registerUserWithKey(b, "alice");
    const att = await uploaded(b, alice, {
      fields: [["target", "other.test"]],
      files: [thumbPart()],
    });
    expect(att.expiresAt).toBeUndefined();
    expect(att.thumbnail?.expiresAt).toBeUndefined();
    expect(att.url).toBe(`https://${DOMAIN}/api/media/${att.id}`);
    // No message or profile here references it; it is still served, and the
    // url is the one the upload returned.
    for (const url of [att.url, att.thumbnail?.url ?? ""]) {
      const res = await b.app.request(new URL(url).pathname);
      expect(res.status).toBe(200);
    }
  });
});

describe("PATCH /api/me/profile avatar (§6.3)", () => {
  test("a remote upload is refused; a local one answers with the updated UserProfile", async () => {
    const b = boot("avatar-target");
    const alice = await registerUserWithKey(b, "alice");
    const patch = (body: unknown) => signedReq(b, alice, "PATCH", "/api/me/profile", body);

    const remote = await uploaded(b, alice, {
      bytes: onePixelPng(),
      mime: "image/png",
      fields: [["target", "other.test"]],
    });
    const refused = await patch({ avatar: remote.url });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { detail?: string }).detail).toContain("remote upload");

    const local = await uploaded(b, alice, { bytes: onePixelPng(), mime: "image/png" });
    const before = Date.now() - 1000;
    const ok = await patch({ avatar: local.url, displayName: "Alice" });
    expect(ok.status).toBe(200);
    const profile = (await ok.json()) as { avatar?: string; updatedAt: string };
    await expectValid("user-profile.json", profile);
    expect(profile).toMatchObject({ avatar: local.url, displayName: "Alice" });
    expect(Date.parse(profile.updatedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("migration 0043_media_target_thumbnail", () => {
  test("adds nullable media.target and media.thumbnail_id; existing rows are local, unthumbnailed", () => {
    const db = openDb(join(tmp, "m0043.sqlite"));
    const id = "0043_media_target_thumbnail";
    runMigrations(
      db,
      migrations.filter((m) => m.id !== id),
    );
    db.sqlite.exec(`
      INSERT INTO media (id, mime, size, filename, hash, width, height, owner, created_at)
      VALUES ('att_old', 'image/png', 4, NULL, 'sha-256:x', NULL, NULL, 'alice@providera.test', 1);
    `);
    expect(migrate(db)).toEqual([id]);
    const row = getMediaRow(db, "att_old");
    expect(row).toMatchObject({ target: null, thumbnailId: null });
    expect(migrate(db)).toEqual([]);
    db.sqlite.close();
  });
});
