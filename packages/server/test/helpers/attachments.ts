/**
 * Test attachments for the §5.8 message checks. A local author's attachment
 * must be an upload on its home provider, so tests that post one record an
 * upload's metadata row (as `POST /api/media` would; the upload route itself is
 * covered by `media.test.ts`) and use the `Attachment` it maps to.
 */
import type { Attachment } from "@forumall/shared";

import type { Config } from "../../src/config.ts";
import type { Db } from "../../src/db/index.ts";
import { insertMediaRow, mintMediaId, rowToAttachment } from "../../src/provider/media.ts";

/** Record an upload by `owner` on provider `p` and return its hosted `Attachment`. */
export function hostedAttachment(
  p: { readonly db: Db; readonly config: Config },
  owner: { readonly actor: string },
  opts: { mime?: string; size?: number; filename?: string } = {},
): Attachment {
  const row = insertMediaRow(p.db, {
    id: mintMediaId(),
    mime: opts.mime ?? "image/png",
    size: opts.size ?? 20480,
    filename: opts.filename ?? "diagram.png",
    hash: `sha-256:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`,
    width: 1024,
    height: 768,
    owner: owner.actor,
  });
  return rowToAttachment(p.config, row);
}
