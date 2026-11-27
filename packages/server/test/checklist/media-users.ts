/**
 * §12 coverage map — Media upload and serving, attachments in messages, my-groups, profiles, presence and privacy.
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const MEDIA_USERS: readonly ChecklistEntry[] = [
  {
    item: "Support single-step media upload at `POST /api/media`, recording its `target` (default: this provider) and setting `mime`, `size` and `hash`, and `width`, `height` and `durationMs` from the bytes when it can determine them or from the uploader otherwise, and accepting an uploader's `thumbnail` part (§5.8)",
    level: "provider-must",
    covers: ["packages/server/test/media.test.ts"],
    status: "partial",
    note: "Behaviour gap: the `target` part (stored, canonicalised, `400` for a bad authority) and the `thumbnail` part are not implemented. Spec question: must `mime` be derived from the bytes, or is the declared part type acceptable?",
  },
  {
    item: "Serve attachments as capability URLs: `https`, at least 128 bits of entropy, unlisted, fetchable unsigned, with the §3.4 CORS headers, from any host the provider chooses (§5.8)",
    level: "provider-must",
    covers: ["packages/server/test/media.test.ts"],
    status: "partial",
    note: "Behaviour present but untested: ≥128 bits of entropy in the id, that uploads are unlisted (no `GET /api/media` listing), and the §3.4 CORS headers on the media `GET`.",
  },
  {
    item: "Check each attachment in a stored message: for one it hosts (from `POST /api/media` or a completed `POST /api/media/uploads`), that the `id` exists, was uploaded by the author, is a local upload, and matches in `mime`, `size` and `hash`; reject any it does not host from a local author; for a remote author's, that `url` and `thumbnail.url` are `https` and the `thumbnail` has no `thumbnail`, dropping the author's `expiresAt` and fetching only under the §8 outbound rules (§5.8)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-create-fields.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/server/test/message-edit-dm.test.ts",
      "packages/shared/test/edits-media-groups.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: no check that a hosted attachment is a local upload (no upload `target` is recorded). Untested: a remote author's `http` `thumbnail.url` is rejected.",
  },
  {
    item: "Serve attachments with `Content-Disposition: attachment` (or `Content-Security-Policy: sandbox` where the host can send it) for types other than images (or for SVG), video and audio, and with `X-Content-Type-Options: nosniff` where the host can send it (§5.8)",
    level: "provider-must",
    covers: [],
    status: "missing",
    note: "`GET /api/media/{id}` sends neither `Content-Disposition: attachment` (or CSP `sandbox`) for non-image/video/audio types or SVG, nor `X-Content-Type-Options: nosniff`, and no test covers it.",
  },
  {
    item: "Give remote uploads a stable `url` without `expiresAt`, and never treat one as unreferenced because no message or profile it holds references it; use short-lived URLs (such as pre-signed `GET` URLs, with `expiresAt`) only for local uploads in messages; keep a pending local upload postable for at least 24 hours before removing it (§5.8)",
    level: "provider-must",
    covers: [],
    status: "missing",
    note: "No target-aware upload lifecycle exists: remote uploads are not distinguished (no `target`), no short-lived URLs are minted and nothing is ever removed, so the MUSTs hold only vacuously. Untestable until remote uploads and upload removal exist.",
  },
  {
    item: "Keep each user's group list at `GET`/`PUT`/`DELETE /api/me/groups` (its own memberships plus unchecked pointers to remote groups) and emit `groups.updated` (§5.7)",
    level: "provider-must",
    covers: [],
    status: "missing",
    note: "Not implemented: no `/api/me/groups` route, pointer storage or `groups.updated` emission in the server; only the shared schemas exist (`packages/shared/test/edits-media-groups.test.ts`).",
  },
  {
    item: 'Answer `PATCH /api/me/profile` with the updated `UserProfile`, clear the avatar on `"avatar": null`, reject a non-`https` `avatar` (SHOULD also reject one it does not host, one whose `mime` is not `image/*`, and a remote upload), and keep a hosted avatar\'s `url` stable, never short-lived (§6.3)',
    level: "provider-must",
    covers: ["packages/server/test/media.test.ts", "packages/server/test/privacy.test.ts"],
    status: "partial",
    note: "Untested: the response is the updated `UserProfile` (schema, advanced `updatedAt`). The SHOULD to reject a remote upload is not implemented (no upload `target`); a hosted avatar's `url` is stable only because all URLs are.",
  },
  {
    item: "Serve `GET /api/users/{userRef}/profile`, `…/presence` and `…/groups` to signed and anonymous viewers, evaluating visibility per §6.1 (subject always; `denyList`, then `allowList`, then the setting); answer a viewer not permitted with the uniform `200` responses (base profile, `offline`, empty groups), never `403`, and every non-hosted, unknown, disabled or invalid subject with the same `404`; list only hosted groups the viewer may read (§6.1–§6.5)",
    level: "provider-must",
    covers: [
      "packages/server/test/privacy.test.ts",
      "packages/server/test/presence.test.ts",
      "packages/server/test/remote-presence-federation.test.ts",
    ],
    status: "partial",
    note: "Behaviour gaps: all three routes require a signature (anonymous viewers get `401`), the groups list is not filtered by what the viewer may read, and a ref containing `%25` is decoded twice (likely `500`, not the uniform `404`). Untested: identical `404` bodies across unknown, invalid and remote subjects, and the groups route's `404`.",
  },
  {
    item: "Treat `PUT /api/me/presence` as a full replace that rejects `offline` with `400`, and `PUT /api/me/privacy` as a partial update that rejects an actor in both lists, or an over-long list, with `400` (§6.4, §6.6)",
    level: "provider-must",
    covers: ["packages/server/test/presence.test.ts", "packages/server/test/privacy.test.ts"],
    status: "covered",
    note: "Spec question: privacy lists also accept a user-object URI and convert it to an actor; does §2.2's conversion of non-canonical actor spellings extend to a URI form, or should it be `400`?",
  },
];
