import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

import {
  AttachmentSchema,
  AuthBootstrapResponseSchema,
  AuthLoginRequestSchema,
  AuthRegistrationRequestSchema,
  CallAnswerSchema,
  CallChannelStateSchema,
  CallIceSchema,
  CallOfferSchema,
  CallSessionSchema,
  ChannelCreateRequestSchema,
  ChannelSchema,
  ChannelUpdateRequestSchema,
  ContactCreateRequestSchema,
  ContactEventSchema,
  ContactSchema,
  ContactsResponseSchema,
  DeviceKeyRegistrationSchema,
  DeviceKeyResponseSchema,
  DiscoverResponseSchema,
  DmConversationSchema,
  DmConversationsResponseSchema,
  DmMessageCreateRequestSchema,
  FollowCreateRequestSchema,
  FollowSchema,
  FollowsResponseSchema,
  GroupCreateRequestSchema,
  GroupSchema,
  GroupUpdateRequestSchema,
  GuestCreateRequestSchema,
  InviteCreateRequestSchema,
  InviteSchema,
  JoinRequestSchema,
  MemberSchema,
  MessageSchema,
  MessageUpdateRequestSchema,
  MessagesPageSchema,
  NotificationsDeliverySchema,
  NotificationsWebhookRegistrationSchema,
  PresenceSchema,
  PrivacySettingsSchema,
  ProblemDetailsSchema,
  ProviderDiscoverySchema,
  ProvidersResponseSchema,
  ReactionSchema,
  TiersResponseSchema,
  UserKeysResponseSchema,
  UserProfileSchema,
  WsAuthChallengeSchema,
  WsAuthenticateSchema,
  WsAuthenticatedSchema,
  WsCallEndedSchema,
  WsCallParticipantSchema,
  WsCallStartedSchema,
  WsChannelTypingSchema,
  WsDmMessageSchema,
  WsDmReactionSchema,
  WsDmTypingSchema,
  WsEnvelopeSchema,
  WsErrorSchema,
  WsMessageCreateSchema,
  WsMessageCreatedSchema,
  WsMessageDeleteSchema,
  WsMessageDeletedSchema,
  WsMessageUpdateSchema,
  WsMessageUpdatedSchema,
  WsPingSchema,
  WsPongSchema,
  WsPresenceSetSchema,
  WsPresenceSubscribeSchema,
  WsPresenceSubscribedSchema,
  WsPresenceUnsubscribeSchema,
  WsPresenceUnsubscribedSchema,
  WsPresenceUpdateSchema,
  WsReactionAddSchema,
  WsReactionAddedSchema,
  WsReactionRemoveSchema,
  WsReactionRemovedSchema,
  WsSubscribeSchema,
  WsSubscribedSchema,
  WsTypingStartSchema,
  WsTypingStopSchema,
  WsUnsubscribeSchema,
  WsUnsubscribedSchema,
  isKnownWsType,
} from "../src/schemas/index.ts";
import {
  ReadMarkerSchema,
  ReadMarkersResponseSchema,
  ReadMarkersUpdateRequestSchema,
  ReadUpdatedEventSchema,
  WsReadUpdatedSchema,
} from "../src/schemas/index.ts";

// The canonical OFSCP samples live in the sibling ofscp repo. Reference by
// path (do NOT copy them in) so this stays pinned to the SSOT. Resolve it
// relative to this file (sibling of the repo root) so it works on any machine
// — same anchor as conformance.test.ts.
const SAMPLES_DIR = fileURLToPath(new URL("../../../../ofscp/tests", import.meta.url));

/**
 * Maps each `<name>.sample.json` to the schema that should accept it. This map
 * IS the completeness guard: the enumeration test fails loudly if a sample file
 * has no entry here, so adding a sample upstream forces a schema here.
 */
const SAMPLE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // Misc objects
  attachment: AttachmentSchema,
  "problem-details": ProblemDetailsSchema,
  "call-answer": CallAnswerSchema,
  "call-ice": CallIceSchema,
  "call-offer": CallOfferSchema,
  "call-channel-state": CallChannelStateSchema,
  "call-session": CallSessionSchema,
  "notifications-delivery": NotificationsDeliverySchema,
  "notifications-webhook-registration": NotificationsWebhookRegistrationSchema,
  "provider-discovery": ProviderDiscoverySchema,

  // Identity / auth
  "auth-bootstrap-response": AuthBootstrapResponseSchema,
  "auth-login-request": AuthLoginRequestSchema,
  "auth-registration-request": AuthRegistrationRequestSchema,
  "device-key-registration": DeviceKeyRegistrationSchema,
  "device-key-response": DeviceKeyResponseSchema,
  "guest-create-request": GuestCreateRequestSchema,
  "user-keys-response": UserKeysResponseSchema,
  "user-profile": UserProfileSchema,

  // Groups / channels
  group: GroupSchema,
  "group-create-request": GroupCreateRequestSchema,
  "group-update-request": GroupUpdateRequestSchema,
  channel: ChannelSchema,
  "channel-create-request": ChannelCreateRequestSchema,
  "channel-update-request": ChannelUpdateRequestSchema,
  invite: InviteSchema,
  "invite-create-request": InviteCreateRequestSchema,
  member: MemberSchema,
  "join-request": JoinRequestSchema,
  "tiers-response": TiersResponseSchema,
  "providers-response": ProvidersResponseSchema,

  // Messaging
  message: MessageSchema,
  "message-update-request": MessageUpdateRequestSchema,
  "messages-page": MessagesPageSchema,
  reaction: ReactionSchema,
  "dm-conversation": DmConversationSchema,
  "dm-conversations-response": DmConversationsResponseSchema,
  "dm-message-create-request": DmMessageCreateRequestSchema,

  // Privacy / social
  presence: PresenceSchema,
  "privacy-settings": PrivacySettingsSchema,
  contact: ContactSchema,
  "contact-create-request": ContactCreateRequestSchema,
  "contact-event": ContactEventSchema,
  "contacts-response": ContactsResponseSchema,
  follow: FollowSchema,
  "follow-create-request": FollowCreateRequestSchema,
  "follows-response": FollowsResponseSchema,
  "discover-response": DiscoverResponseSchema,

  // WebSocket
  "ws-authenticate": WsAuthenticateSchema,
  "ws-auth-challenge": WsAuthChallengeSchema,
  "ws-authenticated": WsAuthenticatedSchema,
  "ws-subscribe": WsSubscribeSchema,
  "ws-subscribed": WsSubscribedSchema,
  "ws-unsubscribe": WsUnsubscribeSchema,
  "ws-unsubscribed": WsUnsubscribedSchema,
  "ws-message-create": WsMessageCreateSchema,
  "ws-message-created": WsMessageCreatedSchema,
  "ws-message-update": WsMessageUpdateSchema,
  "ws-message-updated": WsMessageUpdatedSchema,
  "ws-message-delete": WsMessageDeleteSchema,
  "ws-message-deleted": WsMessageDeletedSchema,
  "ws-reaction-add": WsReactionAddSchema,
  "ws-reaction-added": WsReactionAddedSchema,
  "ws-reaction-remove": WsReactionRemoveSchema,
  "ws-reaction-removed": WsReactionRemovedSchema,
  "ws-typing-start": WsTypingStartSchema,
  "ws-typing-stop": WsTypingStopSchema,
  "ws-channel-typing": WsChannelTypingSchema,
  "ws-dm-message": WsDmMessageSchema,
  "ws-dm-reaction": WsDmReactionSchema,
  "ws-dm-typing": WsDmTypingSchema,
  "ws-presence-set": WsPresenceSetSchema,
  "ws-presence-subscribe": WsPresenceSubscribeSchema,
  "ws-presence-subscribed": WsPresenceSubscribedSchema,
  "ws-presence-unsubscribe": WsPresenceUnsubscribeSchema,
  "ws-presence-unsubscribed": WsPresenceUnsubscribedSchema,
  "ws-presence-update": WsPresenceUpdateSchema,
  "ws-call-started": WsCallStartedSchema,
  "ws-call-ended": WsCallEndedSchema,
  "ws-call-participant": WsCallParticipantSchema,
  "ws-ping": WsPingSchema,
  "ws-pong": WsPongSchema,
  "ws-error": WsErrorSchema,
};

function sampleName(file: string): string {
  return basename(file, ".sample.json");
}

const sampleFiles = readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith(".sample.json"))
  .sort();

describe("OFSCP sample fixtures parse against their schemas", () => {
  test("every sample file has a mapped schema (completeness guard)", () => {
    const unmapped = sampleFiles.map(sampleName).filter((name) => !(name in SAMPLE_SCHEMAS));
    // If this fails, an ofscp sample exists with no corresponding schema.
    expect(unmapped).toEqual([]);
  });

  test("at least the expected number of samples are present", () => {
    // Sanity: guard against an empty/misconfigured SAMPLES_DIR silently passing.
    expect(sampleFiles.length).toBeGreaterThanOrEqual(75);
  });

  for (const file of sampleFiles) {
    const name = sampleName(file);
    test(`${file} parses`, () => {
      const schema = SAMPLE_SCHEMAS[name];
      if (!schema) {
        throw new Error(`no schema mapped for sample "${name}"`);
      }
      const raw = JSON.parse(readFileSync(join(SAMPLES_DIR, file), "utf8"));
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `${file} failed to parse:\n${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
      expect(result.success).toBe(true);
    });
  }
});

describe("forward-compatibility (§2.3): unknown keys are preserved", () => {
  test("an unknown top-level field survives parsing (object schema)", () => {
    const input = {
      user: "jane@a.com",
      role: "admin",
      joinedAt: "2025-03-01T12:00:00Z",
      futureField: { nested: 42 },
    };
    const parsed = MemberSchema.parse(input);
    expect((parsed as Record<string, unknown>).futureField).toEqual({
      nested: 42,
    });
  });

  test("an unknown field inside a nested object survives", () => {
    const input = {
      id: "msg_1",
      author: "jane@a.com",
      type: "message",
      content: { text: "hi", mime: "text/plain", future: true },
      attachments: [],
      createdAt: "2025-03-01T12:00:00Z",
      metadata: [],
    };
    const parsed = MessageSchema.parse(input);
    expect((parsed.content as Record<string, unknown>).future).toBe(true);
  });
});

describe("forward-compatibility (§2.3): unknown WS types do not throw", () => {
  test("an envelope carrying a novel `type` parses successfully", () => {
    const envelope = {
      id: "evt_future",
      type: "some.future.event",
      ts: "2026-01-01T12:00:00Z",
      data: { anything: "goes", n: 1 },
    };
    const result = WsEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("some.future.event");
      expect((result.data.data as Record<string, unknown>).anything).toBe("goes");
    }
  });

  test("isKnownWsType narrows known vs unknown types without throwing", () => {
    expect(isKnownWsType("message.created")).toBe(true);
    expect(isKnownWsType("authenticate")).toBe(true);
    expect(isKnownWsType("some.future.event")).toBe(false);
  });
});

describe("negative cases: missing required fields are rejected", () => {
  test("a Group with no `name` is rejected", () => {
    const result = GroupSchema.safeParse({
      id: "grp_1",
      owner: "jane@a.com",
      joinPolicy: "open",
      tier: "public",
      permissions: {},
      createdAt: "2025-03-01T12:00:00Z",
      updatedAt: "2025-03-01T12:00:00Z",
      metadata: [],
    });
    expect(result.success).toBe(false);
  });

  test("a Message with no `id` is rejected", () => {
    const result = MessageSchema.safeParse({
      author: "jane@a.com",
      type: "message",
      content: { text: "hi", mime: "text/plain" },
      attachments: [],
      createdAt: "2025-03-01T12:00:00Z",
      metadata: [],
    });
    expect(result.success).toBe(false);
  });

  test("a strict auth-login request rejects unknown keys", () => {
    const result = AuthLoginRequestSchema.safeParse({
      handle: "alice",
      password: "pw",
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  test("a WS authenticate frame with a wrong `type` is rejected", () => {
    const result = WsAuthenticateSchema.safeParse({
      id: "cli_1",
      type: "not-authenticate",
      ts: "2026-01-01T12:00:00Z",
      data: {
        actor: "alice@a.com",
        keyId: "k1",
        timestamp: "2026-01-01T12:00:00Z",
        signature: "sig",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("read-markers schemas (provider-local extension)", () => {
  test("a read-marker summary entry parses", () => {
    const r = ReadMarkerSchema.safeParse({ scopeId: "chn_a", lastReadSeq: 7, unreadCount: 2 });
    expect(r.success).toBe(true);
  });

  test("the GET response (summary) parses and preserves unknown keys (§2.3)", () => {
    const r = ReadMarkersResponseSchema.safeParse({
      scopes: [{ scopeId: "chn_a", lastReadSeq: 0, unreadCount: 3, future: "x" }],
      extra: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).extra).toBe(1);
    }
  });

  test("the PATCH request requires at least one marker", () => {
    expect(ReadMarkersUpdateRequestSchema.safeParse({ markers: [] }).success).toBe(false);
    expect(
      ReadMarkersUpdateRequestSchema.safeParse({
        markers: [{ scopeId: "chn_a", lastReadSeq: 5 }],
      }).success,
    ).toBe(true);
  });

  test("a negative lastReadSeq is rejected", () => {
    expect(
      ReadMarkerSchema.safeParse({ scopeId: "chn_a", lastReadSeq: -1, unreadCount: 0 }).success,
    ).toBe(false);
  });

  test("the read.updated event payload + WS frame parse", () => {
    const payload = { markers: [{ scopeId: "chn_a", lastReadSeq: 9, unreadCount: 0 }] };
    expect(ReadUpdatedEventSchema.safeParse(payload).success).toBe(true);
    const frame = WsReadUpdatedSchema.safeParse({
      id: "evt_1",
      type: "read.updated",
      ts: "2026-01-01T12:00:00Z",
      data: payload,
    });
    expect(frame.success).toBe(true);
  });

  test("read.updated is a known WS type", () => {
    expect(isKnownWsType("read.updated")).toBe(true);
  });
});
