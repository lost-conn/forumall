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
    covers: [
      "packages/server/test/auth.test.ts",
      "packages/server/test/device-keys.test.ts",
      "packages/server/test/device-key-management.test.ts",
    ],
    status: "covered",
    context:
      "`device-key-management.test.ts` validates the bootstrap response against the spec schema, checks the token carries ≥128 bits and expires within 15 minutes, and sends it as a Bearer to `GET`/`DELETE /api/auth/device-keys`, `/api/me`, `/api/me/dms`, group create/join and presence: `401` each time, and the token still registers a key afterwards.",
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
      "packages/server/test/device-key-management.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Encode every `public_key` as the raw 32-byte Ed25519 key in padded standard base64, reject (`400`) a registration whose key does not decode to 32 bytes, and, as a verifier, ignore on its own a published key that does not (or whose `algorithm` is unsupported), keeping the document's other keys (`401` for a request signed with it) (§4.3.2)",
    level: "provider-must",
    covers: [
      "packages/server/test/device-keys.test.ts",
      "packages/shared/test/schemas.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/server/test/device-key-management.test.ts",
      "packages/shared/test/published-keys.test.ts",
      "packages/server/test/published-key-usability.test.ts",
    ],
    status: "covered",
    context:
      "Published keys are judged one by one (`isUsablePublishedKey` in `packages/shared/src/published-keys.ts`: `algorithm` exactly `Ed25519`, `public_key` padded base64 of 32 bytes); the keys-response and discovery schemas require only strings, so an unusable entry leaves the document and its other keys usable. A request naming an unusable key treats it as absent: re-fetch (§4.6), then `401`, or `503` when that fetch fails or is rate-limited. Submitted keys (registration, guest creation) stay strictly validated (`400`).",
  },
  {
    item: "Validate Ed25519 request signatures over the §4.4.2 canonical string, including authority binding and nonce replay rejection, with one bounded provider-wide replay store that records a nonce only after the signature verifies; reject a request carrying both `X-OFSCP-Actor` and `X-OFSCP-Provider` with `401` at §4.5 step 1, even when a header names a denied provider (§4.5)",
    level: "provider-must",
    covers: [
      "packages/shared/test/conformance.test.ts",
      "packages/shared/test/signing.test.ts",
      "packages/server/test/signature.test.ts",
      "packages/server/test/nonce-store.test.ts",
      "packages/server/test/replay-warmup.test.ts",
      "packages/server/test/canonical-authority.test.ts",
      "packages/server/test/ws-handshake.test.ts",
      "packages/server/test/provider-signed-routes.test.ts",
      "packages/server/test/replay-store-http.test.ts",
    ],
    status: "covered",
    context:
      "`provider-signed-routes.test.ts` sends both identity headers (a valid user signature plus `X-OFSCP-Provider`, and a provider signature plus `X-OFSCP-Actor`, naming a denied provider in either slot) to public, anonymous-reader, user-only, either-signer and provider-signed routes: `401` at step 1 each time, with no fetch and no nonce recorded.",
  },
  {
    item: "Apply the outbound-request rules (https only, public addresses only, no redirects) to every request to a host named by someone else (§8)",
    level: "provider-must",
    covers: [
      "packages/server/test/egress-guard.test.ts",
      "packages/server/test/signer-resolution.test.ts",
      "packages/server/test/push-delivery-egress.test.ts",
      "packages/server/test/outbound-egress.test.ts",
    ],
    status: "partial",
    note: "DM forwarding (`packages/server/src/http/dm-forwarding.ts`, which unit U23 replaces) is only structurally guarded: it uses the app-wide `federationFetch` (policy over `guardedFetch`), but no test drives a forward through the real guard.",
    context:
      "Push delivery goes through `guardedPushFetch` (`packages/server/src/provider/push-send.ts`, the shared `guardedFetch`); notification-target delivery and the known-providers scrape are driven through the real guard with an injected resolver: `http`, loopback, private, link-local, metadata and mixed-address targets are never contacted, and a `3xx` is returned, not followed. The production default transports of push and the scrape are shown to be the guard: with the global `fetch` replaced by a recorder that would accept, a refused target never reaches it.",
  },
  {
    item: "Apply federation allow/deny policy to every outbound request and to every signed inbound request (`403` at the start of §4.5 step 6 or §8.1 step 2, before any key or discovery fetch, including for a provider-signed request to a route that defines only user signatures, which, from a permitted provider, then gets `401` without a discovery fetch or signature check; WebSocket `4001`); answer unsigned requests to public endpoints regardless (§8)",
    level: "provider-must",
    covers: [
      "packages/server/test/federation-actor.test.ts",
      "packages/server/test/signer-resolution.test.ts",
      "packages/server/test/canonical-authority.test.ts",
      "packages/server/test/dms-pointers.test.ts",
      "packages/server/test/federation-realtime.test.ts",
      "packages/server/test/ws-remote-key.test.ts",
      "packages/server/test/public-route-signatures.test.ts",
      "packages/server/test/provider-signed-routes.test.ts",
      "packages/server/test/push-delivery-egress.test.ts",
      "packages/server/test/outbound-egress.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap (unit U23): the `/api/federation/dms/{dmId}/messages/{messageId}` `PATCH`/`DELETE` and `…/reactions/{key}` `PUT`/`DELETE` routes still accept a permitted provider's signature (`requireActorOrProviderSignature`, `packages/server/src/http/dms-federation.ts`) and verify it against discovery, because Forumall's home provider forwards DM edits, deletes and reactions provider-signed (`packages/server/src/http/dm-forwarding.ts`). The spec defines no route that takes provider signatures and has the client deliver these itself, user-signed (§7.4, §8.3).",
    context:
      "Every route that serves unsigned callers runs §4.5 only when signed (`optionalSignature`). The verifier (`packages/server/src/http/signature.ts`) answers steps 1–5, then the deny `403`, then `401` for a signer kind the route does not take, and only then the warm-up `503`, key resolution and verification. `provider-signed-routes.test.ts` covers a permitted provider (`401`), this provider's own valid key (`401`, not served) and a denied provider (`403`) on public, anonymous-reader and user-only routes, steps 1–5 first (`401` stale, `400` digest), and the same answers inside the warm-up, with an injected transport and replay store showing no fetch and no recorded nonce.",
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
    status: "covered",
    context: "Forumall has no disabled or deleted account state, so that empty case cannot arise.",
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
