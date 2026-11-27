/**
 * Media upload `target` (§5.8): the `POST /api/media` multipart body names the
 * provider that will hold the message as a `target` part beside `file`, and a
 * composer's pending uploads are uploaded again when reused for a message on
 * another provider.
 */
import { describe, expect, test } from "bun:test";
import { type Attachment, generateKeyPair } from "@forumall/shared";
import { buildMediaMultipart, uploadMedia } from "../src/lib/chat-api.ts";
import { OfscpClient } from "../src/lib/ofscp-client.ts";
import { type PendingUpload, retargetUploads, uploadFor } from "../src/lib/pending-uploads.ts";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("buildMediaMultipart", () => {
  test("a `target` part (canonical authority) precedes the `file` part", async () => {
    const file = new File(["abc"], "pic.png", { type: "image/png" });
    const { bytes, contentType } = await buildMediaMultipart("BND", file, "B.Example:443");
    expect(contentType).toBe("multipart/form-data; boundary=BND");
    expect(decode(bytes)).toBe(
      "--BND\r\n" +
        'Content-Disposition: form-data; name="target"\r\n\r\n' +
        "b.example\r\n" +
        "--BND\r\n" +
        'Content-Disposition: form-data; name="file"; filename="pic.png"\r\n' +
        "Content-Type: image/png\r\n\r\n" +
        "abc\r\n" +
        "--BND--\r\n",
    );
  });

  test("without a target there is only the `file` part", async () => {
    const file = new File(["x"], "a.bin", { type: "application/pdf" });
    const { bytes } = await buildMediaMultipart("B", file);
    expect(decode(bytes)).toBe(
      '--B\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n' +
        "Content-Type: application/pdf\r\n\r\nx\r\n--B--\r\n",
    );
  });

  test("a file name cannot break out of its header parameter", async () => {
    const file = new File(["x"], 'a"b\r\nX-Evil: 1.txt');
    const { bytes } = await buildMediaMultipart("B", file);
    expect(decode(bytes)).toContain('filename="a%22b%0D%0AX-Evil: 1.txt"\r\n');
    expect(decode(bytes)).toContain("Content-Type: application/octet-stream\r\n");
  });
});

describe("uploadMedia", () => {
  test("posts the exact multipart bytes, with the target, to the home provider", async () => {
    const { privateKey } = generateKeyPair();
    let seen: { url: string; body: string; type: string | null } | undefined;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as Uint8Array;
      seen = {
        url: String(input),
        body: decode(body),
        type: new Headers(init?.headers).get("content-type"),
      };
      const att: Attachment = {
        id: "att_1",
        mime: "image/png",
        url: "https://a.test/m/1",
        size: 3,
      };
      return new Response(JSON.stringify(att), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new OfscpClient({
      baseUrl: "https://a.test",
      actor: "alice@a.test",
      keyId: "key_1",
      privateKey,
      fetch: fetchStub,
    });
    const att = await uploadMedia(client, new File(["abc"], "p.png", { type: "image/png" }), {
      target: "b.test",
    });
    expect(att.id).toBe("att_1");
    expect(seen?.url).toBe("https://a.test/api/media");
    const boundary = seen?.type?.match(/boundary=(.+)$/)?.[1];
    expect(boundary).toBeDefined();
    expect(
      seen?.body.startsWith(
        `--${boundary}\r\nContent-Disposition: form-data; name="target"\r\n\r\nb.test\r\n`,
      ),
    ).toBe(true);
  });
});

describe("pending uploads and their target", () => {
  const file = (name: string) => new File([name], name);
  /** A fake uploader recording each (file, target) and minting an id per call. */
  function recorder() {
    const calls: Array<{ name: string; target: string }> = [];
    const upload = async (f: File, target: string): Promise<Attachment> => {
      calls.push({ name: f.name, target });
      return {
        id: `att_${calls.length}`,
        mime: "text/plain",
        url: `https://h/m/${calls.length}`,
        size: 1,
      };
    };
    return { calls, upload };
  }

  test("an upload records its canonical target", async () => {
    const { calls, upload } = recorder();
    const p = await uploadFor(file("a"), "B.TEST", upload);
    expect(p.target).toBe("b.test");
    expect(calls).toEqual([{ name: "a", target: "b.test" }]);
  });

  test("reuse on the same target uploads nothing", async () => {
    const { calls, upload } = recorder();
    const pending: PendingUpload[] = [await uploadFor(file("a"), "b.test", upload)];
    const ready = await retargetUploads(pending, "b.test", upload);
    expect(ready).toEqual(pending);
    expect(calls).toHaveLength(1);
  });

  test("uploads made for another provider are uploaded again, in order", async () => {
    const { calls, upload } = recorder();
    const pending: PendingUpload[] = [
      await uploadFor(file("a"), "b.test", upload),
      await uploadFor(file("b"), "c.test", upload),
    ];
    const ready = await retargetUploads(pending, "c.test", upload);
    expect(ready.map((p) => [p.file.name, p.target, p.attachment.id])).toEqual([
      ["a", "c.test", "att_3"],
      ["b", "c.test", "att_2"],
    ]);
    expect(calls.at(-1)).toEqual({ name: "a", target: "c.test" });
    expect(calls).toHaveLength(3);
  });

  test("a failed re-upload rejects", async () => {
    const { upload } = recorder();
    const pending = [await uploadFor(file("a"), "b.test", upload)];
    const failing = async (): Promise<Attachment> => {
      throw new Error("quota");
    };
    await expect(retargetUploads(pending, "c.test", failing)).rejects.toThrow("quota");
  });
});
