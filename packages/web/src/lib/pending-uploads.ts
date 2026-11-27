/**
 * A composer's pending attachments and their §5.8 upload *target*.
 *
 * Every attachment is uploaded to the user's home provider, naming as `target`
 * the provider that will hold the message (the channel's home provider, or for
 * a DM the recipient's provider). An upload may be reused only in messages on
 * its target; to use the same file on another provider the client uploads it
 * again with that provider as the target. A composer that outlives a switch of
 * conversation (the DM composer does) can therefore hold uploads made for a
 * different provider than the message it is about to send: {@link
 * retargetUploads} re-uploads exactly those.
 */
import type { Attachment } from "@forumall/shared";
import { canonicalAuthority } from "@forumall/shared";

/** One pending attachment: the uploaded file, its `Attachment`, and its target. */
export interface PendingUpload {
  /** The picked file, kept so it can be uploaded again for another target. */
  readonly file: File;
  readonly attachment: Attachment;
  /** Canonical authority of the provider the upload was made for. */
  readonly target: string;
}

/** Uploads `file` to the home provider for `target`, returning its attachment. */
export type Uploader = (file: File, target: string) => Promise<Attachment>;

/** Upload `file` for `target` (canonicalised) and record it as a pending upload. */
export async function uploadFor(
  file: File,
  target: string,
  upload: Uploader,
): Promise<PendingUpload> {
  const canonical = canonicalAuthority(target);
  return { file, attachment: await upload(file, canonical), target: canonical };
}

/**
 * Make every pending upload usable in a message held by `target`: keep each one
 * already made for it, upload the others again for it. The result keeps the
 * input order. Rejects with the first failed upload's error.
 */
export async function retargetUploads(
  pending: readonly PendingUpload[],
  target: string,
  upload: Uploader,
): Promise<PendingUpload[]> {
  const canonical = canonicalAuthority(target);
  return Promise.all(
    pending.map((p) => (p.target === canonical ? p : uploadFor(p.file, canonical, upload))),
  );
}
