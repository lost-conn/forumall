/**
 * P9 conformance suite — §12 Compliance Checklist coverage map (machine-checkable).
 *
 * `CHECKLIST` below is the source of truth for the §12 "Provider MUST" and
 * "Client MUST" items (verbatim from `ofscp/docs/ofscp_spec.md` §12), each mapped
 * to the test file(s) that exercise it. The assertions guard against silent rot:
 *  - every MUST item has a NON-EMPTY mapping (you can't add a MUST without a test),
 *  - every mapped test file EXISTS on disk (a rename can't dangle the map),
 *  - the item count matches the spec (a MUST can't be silently dropped).
 *
 * `CONFORMANCE.md` (repo root) is the human-readable rendering of this same map;
 * keep the two in sync. SHOULD/MAY items are tracked there, not asserted here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Repo root: this file is packages/server/test → up 3. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface ChecklistItem {
  /** Verbatim §12 item text. */
  readonly item: string;
  /** Repo-relative test file(s) that cover it. MUST be non-empty for a MUST. */
  readonly covers: readonly string[];
  /** Honest coverage status. */
  readonly status: "covered" | "partial";
  /** Optional note (e.g. what's only partially covered). */
  readonly note?: string;
}

// --- Provider MUST (§12) ---------------------------------------------------
const PROVIDER_MUST: readonly ChecklistItem[] = [
  {
    item: "Support password-based registration and login",
    covers: ["packages/server/test/auth.test.ts"],
    status: "covered",
  },
  {
    item: "Issue scoped, short-lived bootstrap tokens on registration/login (§4.2)",
    covers: ["packages/server/test/auth.test.ts"],
    status: "covered",
  },
  {
    item: "Implement device key registration (bootstrap-authenticated) and revocation",
    covers: ["packages/server/test/device-keys.test.ts"],
    status: "covered",
  },
  {
    item: "Encode every `public_key` as the raw 32-byte Ed25519 key in padded standard base64, and reject (`400`) a registration whose key does not decode to 32 bytes (§4.3.2)",
    covers: ["packages/server/test/device-keys.test.ts", "packages/shared/test/schemas.test.ts"],
    status: "covered",
  },
  {
    item: "Validate Ed25519 request signatures over the §4.4.2 canonical string, including authority binding and nonce replay rejection",
    covers: [
      "packages/shared/test/conformance.test.ts",
      "packages/shared/test/signing.test.ts",
      "packages/server/test/signature.test.ts",
      "packages/server/test/nonce-store.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Authenticate WebSocket connections via the signed auth.challenge/authenticate handshake (§7.1), answering a failure with an error whose code/status mirror the REST answer (401; 403 for federation policy; 503 when the keys could not be fetched) and then close code 4001, never 1013",
    covers: [
      "packages/shared/test/conformance.test.ts",
      "packages/shared/test/ws-auth.test.ts",
      "packages/server/test/ws-handshake.test.ts",
      "packages/server/test/ws-remote-key.test.ts",
      "packages/server/test/federation-realtime.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Follow the WebSocket envelope and command rules (§7.1): accept commands without ts and ignore its value; answer a missing id (after authentication), malformed data or a standard command the provider does not support with error bad_request; ignore unknown non-standard command types (§2.3); use 4001/4003 only for the reasons in the close-code table",
    covers: [
      "packages/shared/test/ws-envelope-schema.test.ts",
      "packages/shared/test/schemas.test.ts",
      "packages/server/test/ws-envelope-rules.test.ts",
      "packages/server/test/ws-handshake.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Subscribe the readable channels of a partially refused subscribe and refuse the rest with one not_found error naming them in details.channels (only the error when none is readable); refuse a subscribe that would exceed the subscription cap as a whole with subscription_limit (§7.1)",
    covers: [
      "packages/server/test/ws-subscriptions.test.ts",
      "packages/server/test/dms-send.test.ts",
      "packages/server/test/federation-realtime.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Serve user public keys via the /.well-known/ofscp/users/{handle}/keys endpoint",
    covers: [
      "packages/server/test/conformance.test.ts",
      "packages/server/test/device-keys.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support group and channel management (create/read/update/delete) with the permission model (§5.5)",
    covers: [
      "packages/server/test/groups.test.ts",
      "packages/server/test/channels.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support group membership: join/leave, member listing, roles, and the request approval flow (§5.7)",
    covers: ["packages/server/test/membership.test.ts", "packages/server/test/conformance.test.ts"],
    status: "covered",
  },
  {
    item: 'Support message creation of every type (message, memo, article) with attachments, reference, tags and metadata, over both message.create and POST …/messages, gated by post:<type> and by replyOnly / replyOnlyTo (which only a valid reply, reference.type "reply" naming an existing message in the channel, satisfies), answering 404 for a channel the actor cannot read (§5.2.1, §7.1)',
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/server/test/ws-correlation.test.ts",
      "packages/server/test/channel-permissions.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/shared/test/message-create-schema.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Treat (author, channelId, clientMessageId) as idempotent, running only authentication, visibility and the actor's permission checks before the duplicate lookup and returning the existing message on a duplicate (over WebSocket as a message.created with no cursor); echo clientMessageId on the author's message.created, live or replayed, and on every create response (§7.1, §7.4)",
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/server/test/ws-message-create.test.ts",
      "packages/server/test/dms-send.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Carry the full canonical Message in message.created, message.updated and dm.message (§7.1, §7.4)",
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/shared/test/message-create-schema.test.ts",
      "packages/shared/test/schemas.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support message edit (author-only, editUntil) and tombstone delete (§7.1)",
    covers: [
      "packages/server/test/message-edit-delete.test.ts",
      "packages/server/test/ws-correlation.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support direct messages: deterministic dmId derivation, inbox-only storage (no sender copy), the {dmId} verification on delivery, conversation listing/reading, and dm.message real-time delivery (§7.4)",
    covers: [
      "packages/shared/test/conformance.test.ts",
      "packages/shared/test/dm.test.ts",
      "packages/server/test/dms-send.test.ts",
      "packages/server/test/dms-pointers.test.ts",
      "packages/server/test/dms-read.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support the explicit contacts model (request/accept/remove, local and federated) backing the contacts visibility tier (§6.7)",
    covers: ["packages/server/test/contacts.test.ts"],
    status: "covered",
  },
  {
    item: "Publish provider signing key(s) in discovery and sign provider-to-provider requests (§8.1)",
    covers: [
      "packages/shared/test/signing.test.ts",
      "packages/server/test/federation.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Accept direct-WS connections from remote members — resolve remote keys via §4.6, enforce prior membership + tier at subscribe-time — and advertise capabilities.federation.realtimeDelivery (§8.5)",
    covers: [
      "packages/server/test/federation-realtime.test.ts",
      "packages/server/test/federation-actor.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support the follow list (GET/POST/DELETE /api/me/follows) as pointers only — no server-side feed compilation or content replication (§7.6)",
    covers: ["packages/server/test/follows.test.ts", "packages/server/test/conformance.test.ts"],
    status: "covered",
  },
  {
    item: "Support WebSocket resume (since replay with per-message cursors) and the ping/pong heartbeat (§7.1)",
    covers: [
      "packages/server/test/ws-resume.test.ts",
      "packages/server/test/ws-envelope-rules.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support real-time presence over WebSocket: presence.subscribe/set, presence.update fan-out, connection-derived online/offline, and §6.1 visibility filtering consistent with the REST presence endpoint (§7.5)",
    covers: ["packages/server/test/presence.test.ts", "packages/server/test/conformance.test.ts"],
    status: "covered",
  },
  {
    item: "Treat `PUT /api/me/presence` as a full replace that rejects `offline` with `400`, and `PUT /api/me/privacy` as a partial update that rejects an actor in both lists, or an over-long list, with `400` (§6.4, §6.6)",
    covers: [
      "packages/server/test/presence.test.ts",
      "packages/server/test/privacy.test.ts",
      "packages/shared/test/schemas.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support message fan-out + notification endpoints",
    covers: [
      "packages/server/test/notifications.test.ts",
      "packages/server/test/ws-hub-fanout.test.ts",
      "packages/server/test/ws-message-create.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Enforce tiers per channel and group",
    covers: [
      "packages/server/test/channels.test.ts",
      "packages/server/test/groups.test.ts",
      "packages/server/test/messages.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support the private tier",
    covers: ["packages/server/test/groups.test.ts", "packages/server/test/channels.test.ts"],
    status: "covered",
  },
  {
    item: "Expose GET /api/tiers endpoint",
    covers: ["packages/server/test/conformance.test.ts", "packages/server/test/server.test.ts"],
    status: "covered",
  },
  {
    item: "Provide metadata schema registry (optional entries allowed)",
    covers: ["packages/shared/test/schemas.test.ts"],
    status: "partial",
    note: "Forward-compat metadata lists (§2.3) are validated end-to-end; an explicit named-schema registry endpoint is not exposed (entries are OPTIONAL).",
  },
];

// --- Client MUST (§12) -----------------------------------------------------
// The forumall web client lives in packages/web; its protocol-critical signing,
// dmId derivation, and WS handshake all run through @forumall/shared, so the
// shared conformance vectors are the authoritative proof for these items.
const CLIENT_MUST: readonly ChecklistItem[] = [
  {
    item: "Support Ed25519 request signing over the §4.4.2 canonical string (fresh per-request nonce, body digest) for all authenticated requests",
    covers: ["packages/shared/test/conformance.test.ts", "packages/shared/test/signing.test.ts"],
    status: "covered",
  },
  {
    item: "Complete the WebSocket signed-challenge handshake before sending other commands (§7.1)",
    covers: ["packages/shared/test/conformance.test.ts", "packages/shared/test/ws-auth.test.ts"],
    status: "covered",
  },
  {
    item: "Derive dmId per §7.4 and retain locally-sent DMs (no sender copy is stored server-side)",
    covers: ["packages/shared/test/conformance.test.ts", "packages/shared/test/dm.test.ts"],
    status: "partial",
    note: "dmId derivation is proven by vector; client-side retention of locally-sent DMs is a web-UI concern not covered by these protocol tests.",
  },
  {
    item: "For remote channels, open the real-time WebSocket to the channel's home provider (not the user's own) and complete the §7.1 handshake there (§8.5)",
    covers: ["packages/server/test/federation-realtime.test.ts"],
    status: "partial",
    note: "The provider side (accepting remote direct-WS + handshake) is tested; the web client's home-provider WS routing is not exercised by a client test here.",
  },
  {
    item: "Compose the home feed client-side by reading each followed channel live from its source (§7.6); do not rely on a server-compiled feed",
    covers: ["packages/server/test/follows.test.ts"],
    status: "partial",
    note: "The provider guarantee (follows are pointers only; no server feed) is tested; the client's live feed composition is a web-UI concern.",
  },
  {
    item: "Treat the message.created that answers a duplicate create (no cursor) as the result of the pending send, not as a new message, and never store it as a resume point (§7.1)",
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/shared/test/message-create-schema.test.ts",
      "packages/web/test/chat-store.test.ts",
    ],
    status: "partial",
    note: "The provider's cursor-less, correlated duplicate answer is tested, and so is the web chat store's match of a pending send by clientMessageId and author; the chat controller's end-to-end handling of the duplicate frame is web-UI behaviour not exercised here.",
  },
  {
    item: "Support all message types or graceful fallback",
    covers: ["packages/shared/test/schemas.test.ts"],
    status: "covered",
    note: "Forward-compat parsing (§2.3): unknown message/WS types survive parsing without throwing.",
  },
];

const ALL: readonly ChecklistItem[] = [...PROVIDER_MUST, ...CLIENT_MUST];

describe("§12 Compliance Checklist coverage map", () => {
  // These counts pin the map to the spec; bump them when §12 changes (and update
  // CONFORMANCE.md). A mismatch means an item was added/removed upstream.
  test("item counts match the spec's §12 MUST lists", () => {
    expect(PROVIDER_MUST.length).toBe(28);
    expect(CLIENT_MUST.length).toBe(7);
  });

  test("every MUST item has a non-empty mapping", () => {
    const unmapped = ALL.filter((c) => c.covers.length === 0).map((c) => c.item);
    expect(unmapped).toEqual([]);
  });

  test("every mapped test file exists on disk", () => {
    const missing: string[] = [];
    for (const c of ALL) {
      for (const f of c.covers) {
        if (!existsSync(join(REPO_ROOT, f))) missing.push(f);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every item declares an honest status", () => {
    for (const c of ALL) {
      expect(["covered", "partial"]).toContain(c.status);
      // A `partial` item must explain what's missing.
      if (c.status === "partial") expect(typeof c.note).toBe("string");
    }
  });

  test("prints the coverage summary", () => {
    const partials = ALL.filter((c) => c.status === "partial");
    console.log(
      `\n§12 coverage: ${ALL.length} MUST items mapped (${PROVIDER_MUST.length} Provider, ${CLIENT_MUST.length} Client); ` +
        `${ALL.length - partials.length} fully covered, ${partials.length} partial.\n`,
    );
    expect(ALL.length).toBe(35);
  });
});
