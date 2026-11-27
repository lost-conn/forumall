/**
 * Chat REST surface (P8): message history paging (§7.2), per-message reaction
 * history (§7.1), media upload (§5.8), plus small helpers (client message ids,
 * attachment-URL resolution for inline rendering).
 *
 * Live messaging/reactions/typing flow over the WS (`OfscpWsClient`); these REST
 * calls backfill history and upload attachments. Everything goes through the
 * session's signing {@link OfscpClient} so requests carry the §4.4 signature.
 */
import type { Attachment, Message, Reaction } from "@forumall/shared";
import { type OfscpClient, ofscpRequestMeta } from "./ofscp-client.ts";
import { baseUrlForHost } from "./provider.ts";

/**
 * One page of channel history or replies (§7.2 messages-page). Its items are
 * messages only, tombstones included; reactions come from `…/reactions` and
 * reaction events, never from a timeline (§7.1).
 */
export interface MessagesPageResult {
  messages: Message[];
  nextCursor: string | null;
}

/**
 * Read one page of channel history, newest-first by default (backward paging).
 * `cursor` is the opaque `nextCursor` from a prior page ("load older").
 */
export async function fetchHistory(
  client: OfscpClient,
  groupId: string,
  channelId: string,
  opts: { cursor?: string; limit?: number; direction?: "backward" | "forward" } = {},
): Promise<MessagesPageResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  params.set("direction", opts.direction ?? "backward");
  const qs = params.toString();
  const res = await client.get<{ items: Message[]; page: { nextCursor?: string | null } }>(
    `/api/groups/${groupId}/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
  );
  return { messages: res.data.items ?? [], nextCursor: res.data.page?.nextCursor ?? null };
}

/**
 * Read one page of the replies to a message (§7.2) — the thread under a parent,
 * oldest-first by default. Returns messages + the next cursor. Used to nest
 * replies under a memo/article and to expand a thread whose parent is outside
 * the loaded window.
 */
export async function fetchReplies(
  client: OfscpClient,
  groupId: string,
  channelId: string,
  messageId: string,
  opts: { cursor?: string; limit?: number; direction?: "backward" | "forward" } = {},
): Promise<MessagesPageResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  params.set("direction", opts.direction ?? "forward");
  const qs = params.toString();
  const res = await client.get<{ items: Message[]; page: { nextCursor?: string | null } }>(
    `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/replies${qs ? `?${qs}` : ""}`,
  );
  return { messages: res.data.items ?? [], nextCursor: res.data.page?.nextCursor ?? null };
}

/** Fetch the reaction history for one message (late-joiner / history backfill). */
export async function fetchReactions(
  client: OfscpClient,
  groupId: string,
  channelId: string,
  messageId: string,
): Promise<Reaction[]> {
  const res = await client.get<{ items: Reaction[] }>(
    `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions`,
  );
  return res.data.items ?? [];
}

// ---------------------------------------------------------------------------
// Media upload (§5.8) — signed multipart
// ---------------------------------------------------------------------------

/**
 * Upload a file as `multipart/form-data` to `POST /api/media` and return the
 * hosted {@link Attachment}.
 *
 * The §4.4 signature digests the EXACT request-body bytes, so we build the
 * multipart body ourselves (one `file` part) and hand those exact bytes to the
 * signing client as the body, with the matching `multipart/form-data; boundary=…`
 * content-type. This keeps the digest the server recomputes byte-identical to
 * what we signed (the server re-parses the same cached raw bytes).
 */
export async function uploadMedia(client: OfscpClient, file: File): Promise<Attachment> {
  const boundary = `----forumall${ofscpRequestMeta.generateNonce(12)}`;
  const { bytes, contentType } = await buildMultipart(boundary, file);
  // Use the binary-safe signed POST: the multipart body contains raw image bytes,
  // which must NOT be UTF-8 round-tripped (that corrupts them). `postBinary` signs
  // + sends the exact bytes.
  const res = await client.postBinary<Attachment>("/api/media", bytes, contentType);
  return res.data;
}

/** Build a single-part `multipart/form-data` body (`file`), returning its bytes. */
async function buildMultipart(
  boundary: string,
  file: File,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const enc = new TextEncoder();
  const filename = file.name || "upload";
  const fileType = file.type || "application/octet-stream";
  const header = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${fileType}\r\n\r\n`,
  );
  const body = new Uint8Array(await file.arrayBuffer());
  const footer = enc.encode(`\r\n--${boundary}--\r\n`);
  const bytes = new Uint8Array(header.length + body.length + footer.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  bytes.set(footer, header.length + body.length);
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// Attachment URL resolution (inline rendering)
// ---------------------------------------------------------------------------

/**
 * Resolve an attachment URL for use in `<img src>` / a link. The server hosts
 * media at `https://{domain}/api/media/{id}`, but in dev/test the page is served
 * over the SAME host on plain `http` — so a literal `https://localhost:PORT/…`
 * `<img>` would fail. When the attachment host matches the page origin's host we
 * rewrite to the page origin's scheme (mirrors {@link baseUrlForHost}); otherwise
 * the canonical absolute URL is returned unchanged.
 */
export function resolveAttachmentUrl(url: string): string {
  try {
    const u = new URL(url);
    if (typeof location !== "undefined" && u.host === location.host) {
      return `${location.origin}${u.pathname}${u.search}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Attachment rendering kind, derived solely from the `mime` prefix (ignoring any
 * `; codecs=…` parameters). This is the SINGLE source of truth for how
 * {@link AttachmentView} chooses an element — do not re-derive kind elsewhere.
 */
export type AttachmentKind = "image" | "video" | "audio" | "file";

/** Classify an attachment's `mime` into a rendering kind. */
export function attachmentKind(att: Attachment): AttachmentKind {
  const mime = att.mime.split(";", 1)[0]?.trim() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

/** True when an attachment is an image we can render inline. */
export function isImageAttachment(att: Attachment): boolean {
  return attachmentKind(att) === "image";
}

/** A fresh client message id for optimistic-echo correlation. */
export function newClientMessageId(): string {
  return `cmid_${ofscpRequestMeta.generateNonce(12)}`;
}

export { baseUrlForHost };
