/**
 * §12 coverage map — Registration, bootstrap tokens, device keys, request signing, outbound rules, CORS, the WebSocket handshake and envelope, and key fetching.
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const AUTH_SIGNING: readonly ChecklistEntry[] = [
  {
    item: "Support password-based login, and registration according to the advertised registration mode (§4.1.1)",
    level: "provider-must",
    covers: ["packages/server/test/auth.test.ts", "packages/server/test/server.test.ts"],
    status: "covered",
    context:
      "Only the `open` registration mode is implemented (allowed: a provider picks its mode), so `registration_closed` / `invite_required` are defined but never sent.",
  },
  {
    item: "Issue scoped, short-lived bootstrap tokens on registration/login (§4.2)",
    level: "provider-must",
    covers: ["packages/server/test/auth.test.ts", "packages/server/test/device-keys.test.ts"],
    status: "partial",
    note: "Untested: a bootstrap token sent to any other endpoint (e.g. `GET`/`DELETE /api/auth/device-keys`, `/api/me`) is rejected with `401`; the behaviour holds because only `POST /api/auth/device-keys` reads the bearer. The ≥128-bit entropy is asserted only as `length > 20`.",
  },
  {
    item: "Implement device key registration (bootstrap-authenticated), listing, and revocation, closing revoked keys' WebSocket connections with `4003` (§4.7)",
    level: "provider-must",
    covers: [
      "packages/server/test/device-keys.test.ts",
      "packages/server/test/signature.test.ts",
      "packages/server/test/ws-access-revocation.test.ts",
      "packages/server/test/remote-handle-impersonation.test.ts",
      "packages/server/test/federation-realtime.test.ts",
    ],
    status: "partial",
    note: "The device-key list item shape (`algorithm`, `public_key`, `device_name`, `created_at`) is never asserted and `GET /api/auth/device-keys` is not validated against `device-keys-response.json`.",
  },
  {
    item: "Encode every `public_key` as the raw 32-byte Ed25519 key in padded standard base64, reject (`400`) a registration whose key does not decode to 32 bytes, and, as a verifier, ignore on its own a published key that does not (or whose `algorithm` is unsupported), keeping the document's other keys (`401` for a request signed with it) (§4.3.2)",
    level: "provider-must",
    covers: [
      "packages/server/test/device-keys.test.ts",
      "packages/shared/test/schemas.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Untested: guest creation (§4.8) with a key that is not 32 bytes → `400`, and per-key handling of published keys (behaviour gap: today one key that does not decode to 32 bytes, or has an unsupported `algorithm`, invalidates the whole keys or discovery document, where only that key should be ignored and a request signed with it get `401`).",
  },
  {
    item: "Validate Ed25519 request signatures over the §4.4.2 canonical string, including authority binding and nonce replay rejection, with one bounded provider-wide replay store that records a nonce only after the signature verifies (§4.5)",
    level: "provider-must",
    covers: [
      "packages/shared/test/conformance.test.ts",
      "packages/shared/test/signing.test.ts",
      "packages/server/test/signature.test.ts",
      "packages/server/test/nonce-store.test.ts",
      "packages/server/test/replay-warmup.test.ts",
      "packages/server/test/canonical-authority.test.ts",
      "packages/server/test/ws-handshake.test.ts",
    ],
    status: "partial",
    note: "Untested over HTTP: a full replay store → `503` + `Retry-After` (only the store unit test), a replayed provider-signed (§8.1) request → `401`, and the atomic re-check after step 7 (two concurrent copies → exactly one `200`).",
  },
  {
    item: "Apply the outbound-request rules (https only, public addresses only, no redirects) to every request to a host named by someone else (§8)",
    level: "provider-must",
    covers: [
      "packages/server/test/egress-guard.test.ts",
      "packages/server/test/signer-resolution.test.ts",
    ],
    status: "partial",
    note: "Push delivery to an `http`, private or redirecting endpoint is untested. Notification-target delivery, DM forwarding and the known-providers scrape are only structurally guarded: their tests inject a `federationFetch` that bypasses `guardedFetch`.",
  },
  {
    item: "Apply federation allow/deny policy to every outbound request and to every signed inbound request (`403` at the start of §4.5 step 6 or §8.1 step 2, before any key or discovery fetch; WebSocket `4001`); answer unsigned requests to public endpoints regardless (§8)",
    level: "provider-must",
    covers: [
      "packages/server/test/federation-actor.test.ts",
      "packages/server/test/signer-resolution.test.ts",
      "packages/server/test/canonical-authority.test.ts",
      "packages/server/test/dms-pointers.test.ts",
      "packages/server/test/federation-realtime.test.ts",
      "packages/server/test/ws-remote-key.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: a signed request from a denied provider to a public route that does no signature checking (discovery, the keys endpoint, `/problems/*`, `/api/tiers`, `/api/health`) is served instead of `403` (spec question: must such routes run §4.5 steps 1–5 first?). Untested: steps 1–5 winning over the `403`, the `403`'d nonce not being recorded, unsigned public reads under a deny list, push to a since-denied host, and the provider's own authority being exempt.",
  },
  {
    item: "Allow cross-origin access per §3.4 (CORS preflight and headers; no `Origin` check on WebSocket upgrades) on every endpoint in §3.4's scope (standard endpoints, `/.well-known/ofscp…`, attachment and pre-signed upload URLs); non-standard ambient-credential endpoints SHOULD stay same-origin",
    level: "provider-must",
    covers: ["packages/server/test/cors.test.ts"],
    status: "covered",
    context:
      "`http/cors.ts` is a global, credential-less wildcard, so non-standard endpoints get CORS too; none relies on ambient authority (admin is signature-authed). There are no pre-signed upload URLs.",
  },
  {
    item: "Authenticate WebSocket connections via the signed `auth.challenge`/`authenticate` handshake (§7.1), answering a failure with an `error` whose `code`/`status` mirror the REST answer (`401`; `403` for federation policy; `503` when the keys could not be fetched) and then close code `4001`, never `1013`",
    level: "provider-must",
    covers: [
      "packages/server/test/ws-handshake.test.ts",
      "packages/server/test/ws-remote-key.test.ts",
      "packages/server/test/federation-realtime.test.ts",
      "packages/shared/test/ws-auth.test.ts",
      "packages/shared/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Follow the WebSocket envelope and command rules (§7.1): accept commands without `ts` and ignore its value; answer a missing `id` (after authentication), malformed `data` (other than in `authenticate`, which fails authentication) or a standard command the provider does not support with `error` `bad_request`; ignore unknown non-standard command types (§2.3); use `4001`/`4003` only for the reasons in the close-code table",
    level: "provider-must",
    covers: [
      "packages/server/test/ws-envelope-rules.test.ts",
      "packages/server/test/ws-handshake.test.ts",
      "packages/server/test/ws-access-revocation.test.ts",
      "packages/shared/test/ws-envelope-schema.test.ts",
    ],
    status: "covered",
    context:
      "An unsupported standard command is only unit-tested through `routeCommand`: every standard command has a handler, so no socket-level case exists.",
  },
  {
    item: "Subscribe the readable channels of a partially refused `subscribe` and refuse the rest with one `not_found` `error` naming them in `details.channels` (only the `error` when none is readable); refuse a `subscribe` that would exceed the subscription cap as a whole with `subscription_limit` (a provider may do this without evaluating access when the list names more distinct channels than the cap); never answer `bad_request` to a well-formed `subscribe` because its list is long (§7.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/ws-subscriptions.test.ts",
      "packages/server/test/dms-send.test.ts",
      "packages/server/test/federation-realtime.test.ts",
    ],
    status: "covered",
    context:
      "The optional early refusal (without evaluating access) of an over-long list is not implemented.",
  },
  {
    item: "Serve user public keys via the `/.well-known/ofscp/users/{handle}/keys` endpoint (`200` + `keys: []` for any well-formed unknown, disabled or keyless handle, and `404` for a handle that is not well-formed, §4.6)",
    level: "provider-must",
    covers: [
      "packages/server/test/device-keys.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: a handle that is not well-formed must get `404`; today one containing `@` or whitespace answers `500` and a non-canonical one such as `Alice` an empty `200`. Untested: the unknown-handle and keyless (never-added-a-key) answers are identical, `cache_until` included.",
  },
  {
    item: "Re-fetch keys or discovery on an unknown `key_id` before rejecting; answer `503`, not `401`, when they cannot be fetched (§4.6, §8.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/signer-resolution.test.ts",
      "packages/server/test/federation-actor.test.ts",
      "packages/server/test/federation.test.ts",
      "packages/server/test/key-lookup-expiry.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Reject a keys response whose `actor` is not the requested actor, and a discovery document whose `provider.domain` is not the authority it was fetched from (§3.1, §4.6); answer `403` for a denied signer and `401` when the outbound-request rules forbid the fetch (§4.6, §8)",
    level: "provider-must",
    covers: [
      "packages/server/test/signer-resolution.test.ts",
      "packages/server/test/canonical-authority.test.ts",
      "packages/server/test/federation-actor.test.ts",
    ],
    status: "covered",
  },
];
