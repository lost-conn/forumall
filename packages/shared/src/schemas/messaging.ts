/**
 * OFSCP v0.1 messaging schemas — mirrors `defs/messaging.json` plus the
 * top-level message / reaction / messages-page / DM documents.
 */
import { z } from "zod";

import {
  AttachmentSchema,
  DmIdSchema,
  HttpsUriSchema,
  LocalIdSchema,
  MetadataListSchema,
  MimeTypeSchema,
  OpaqueCursorSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Message primitives (defs/messaging.json)
// ---------------------------------------------------------------------------

/**
 * Message body text + mime (`Content`, §5.3 Content formats). Every provider
 * accepts text/plain and text/markdown; a body places the message's own
 * attachments inline with `attachment:<id>` references.
 */
export const ContentSchema = z
  .object({
    text: z.string(),
    mime: MimeTypeSchema,
  })
  .passthrough();
export type Content = z.infer<typeof ContentSchema>;

/** Typed reference to another object, e.g. a reply (`MessageReference`). */
export const MessageReferenceSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();
export type MessageReference = z.infer<typeof MessageReferenceSchema>;

/** Per-message permission hints (`Permissions`). */
export const MessagePermissionsSchema = z
  .object({
    editUntil: Rfc3339DateTimeSchema.optional(),
  })
  .passthrough();
export type MessagePermissions = z.infer<typeof MessagePermissionsSchema>;

/**
 * Actors the message mentions, set by the author's client (§5.3). When present
 * it is authoritative for mention notifications (§10.1); when absent, mentions
 * are parsed from the text.
 */
export const MentionsSchema = z.array(UserRefSchema);
export type Mentions = z.infer<typeof MentionsSchema>;

/**
 * The article fields of a message (§5.3): plain-text `title` and `summary`, and
 * `cover`, the id of one of the message's own attachments. Defined only for
 * type `article`; ignored on other types.
 */
const ArticleFieldsShape = {
  title: z.string().optional(),
  summary: z.string().optional(),
  cover: LocalIdSchema.optional(),
};

// ---------------------------------------------------------------------------
// Message (message.json → BaseMessage; the message|memo|article variants)
// ---------------------------------------------------------------------------

/** The message kind discriminator (`BaseMessage.type`, §5.3). */
export const MessageKindSchema = z.enum(["message", "memo", "article"]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/**
 * A chat/memo/article message (`BaseMessage`). `clientMessageId` echoes the
 * idempotency key the create carried (§7.1, §7.4): present on the author's
 * `message.created` and on every create response, optional elsewhere.
 */
export const MessageSchema = z
  .object({
    id: z.string().min(1),
    clientMessageId: z.string().min(1).optional(),
    author: UserRefSchema,
    type: MessageKindSchema,
    content: ContentSchema,
    attachments: z.array(AttachmentSchema),
    reference: MessageReferenceSchema.optional(),
    tags: z.array(z.string()).optional(),
    mentions: MentionsSchema.optional(),
    ...ArticleFieldsShape,
    replyCount: z.number().int().min(0).optional(),
    createdAt: Rfc3339DateTimeSchema,
    editedAt: Rfc3339DateTimeSchema.optional(),
    deletedAt: Rfc3339DateTimeSchema.optional(),
    permissions: MessagePermissionsSchema.optional(),
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Message = z.infer<typeof MessageSchema>;

/** A reaction on a message (`Reaction`). */
export const ReactionSchema = z
  .object({
    id: z.string().min(1),
    author: UserRefSchema,
    key: z.string().min(1),
    unicode: z.string().optional(),
    image: HttpsUriSchema.optional(),
    reference: MessageReferenceSchema,
    createdAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type Reaction = z.infer<typeof ReactionSchema>;

/**
 * Body of `PUT …/reactions/{key}` (`reaction-put-request.json`, §7.1; the DM
 * route §7.4 and its federation route §8.3 take the same body). The body is
 * optional: an absent or empty body is not checked at all, and `{}` is valid.
 * `unicode` and `image` are each optional and independent of each other and of
 * the path's `key`, which alone identifies the reaction.
 */
export const ReactionPutRequestSchema = z
  .object({
    unicode: z.string().optional(),
    image: HttpsUriSchema.optional(),
  })
  .passthrough();
export type ReactionPutRequest = z.infer<typeof ReactionPutRequestSchema>;

/**
 * An item of channel history or of a reply listing (`TimelineItem`, §7.2): a
 * message only, tombstones included. Reactions are never timeline items; they
 * come only from the `…/reactions` listing and reaction events (§7.1).
 */
export const TimelineItemSchema = MessageSchema;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

// ---------------------------------------------------------------------------
// Paging (PagedResponse) + messages-page
// ---------------------------------------------------------------------------

/** Cursor pair on a paged response (`PagedResponse.page`). */
export const PageInfoSchema = z
  .object({
    nextCursor: OpaqueCursorSchema.optional(),
    prevCursor: OpaqueCursorSchema.optional(),
  })
  .passthrough();
export type PageInfo = z.infer<typeof PageInfoSchema>;

/**
 * Generic paged response (`PagedResponse`). Item shape is refined by the
 * concrete response schemas (messages-page, dm-conversations, discover).
 */
export const PagedResponseSchema = z
  .object({
    items: z.array(z.unknown()),
    page: PageInfoSchema,
  })
  .passthrough();
export type PagedResponse = z.infer<typeof PagedResponseSchema>;

/** GET .../messages response (`messages-page`): timeline items + page. */
export const MessagesPageSchema = z
  .object({
    items: z.array(TimelineItemSchema),
    page: PageInfoSchema,
  })
  .passthrough();
export type MessagesPage = z.infer<typeof MessagesPageSchema>;

/**
 * Body that creates a channel message (`MessageCreate`, §7.1): the body of
 * `POST /api/groups/{groupId}/channels/{channelId}/messages`
 * (`message-create-request`) and, plus `groupId`/`channelId`, the `data` of the
 * WS `message.create` command. The provider sets `id`, `author`, `createdAt`
 * and `permissions`; omitted `type` means `message`, omitted `attachments` /
 * `metadata` mean `[]`.
 */
export const MessageCreateRequestSchema = z
  .object({
    clientMessageId: z.string().min(1).optional(),
    type: MessageKindSchema.optional(),
    content: ContentSchema,
    attachments: z.array(AttachmentSchema).optional(),
    reference: MessageReferenceSchema.optional(),
    tags: z.array(z.string()).optional(),
    mentions: MentionsSchema.optional(),
    ...ArticleFieldsShape,
    metadata: MetadataListSchema.optional(),
  })
  .passthrough();
export type MessageCreateRequest = z.infer<typeof MessageCreateRequestSchema>;

/**
 * The fields an edit may carry (`MessageUpdate`, §7.1 Editing). Each field
 * present replaces the stored value; absent fields are unchanged. The article
 * fields take `null` to remove the stored value. `type`, `reference` and
 * `metadata` cannot be edited (unknown keys pass through, as everywhere).
 *
 * Kept as a plain object so the WS `message.update` command can extend it with
 * its target ids; {@link MessageUpdateRequestSchema} adds the
 * at-least-one-field rule.
 */
export const MessageUpdateFieldsSchema = z
  .object({
    content: ContentSchema.optional(),
    attachments: z.array(AttachmentSchema).optional(),
    tags: z.array(z.string()).optional(),
    mentions: MentionsSchema.optional(),
    title: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    cover: LocalIdSchema.nullable().optional(),
  })
  .passthrough();

/** The fields of a `MessageUpdate`, one of which every edit must carry (§7.1). */
export const MESSAGE_UPDATE_FIELDS = [
  "content",
  "attachments",
  "tags",
  "mentions",
  "title",
  "summary",
  "cover",
] as const;

/** The issue message when an edit carries none of {@link MESSAGE_UPDATE_FIELDS}. */
export const NO_EDIT_FIELD_MESSAGE = `an edit must carry at least one of: ${MESSAGE_UPDATE_FIELDS.join(", ")}`;

/**
 * True iff `update` carries at least one {@link MESSAGE_UPDATE_FIELDS} entry.
 * An edit carrying none is a 400 (§7.1). Whether only article fields were sent
 * to a non-article (also a 400) depends on the stored message, so that check is
 * the provider's, not the schema's.
 */
export function carriesAnEditField(update: Record<string, unknown>): boolean {
  return MESSAGE_UPDATE_FIELDS.some((field) => update[field] !== undefined);
}

/**
 * PATCH .../messages/{messageId} body (`message-update-request`, §7.1), in a
 * channel or a DM (§7.4, §8.3): a `MessageUpdate` carrying at least one field.
 */
export const MessageUpdateRequestSchema = MessageUpdateFieldsSchema.refine(carriesAnEditField, {
  message: NO_EDIT_FIELD_MESSAGE,
});
export type MessageUpdateRequest = z.infer<typeof MessageUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// Direct messages (dm-conversation, dm-conversations-response, dm-message-create-request)
// ---------------------------------------------------------------------------

/** A DM conversation summary (`dm-conversation`). v0.1 = exactly 2 participants. */
export const DmConversationSchema = z
  .object({
    id: DmIdSchema,
    participants: z.array(UserRefSchema).min(2).max(2),
    lastMessage: MessageSchema.optional(),
    updatedAt: Rfc3339DateTimeSchema,
    metadata: MetadataListSchema,
  })
  .passthrough();
export type DmConversation = z.infer<typeof DmConversationSchema>;

/** GET /api/me/dms response (`dm-conversations-response`). */
export const DmConversationsResponseSchema = z
  .object({
    items: z.array(DmConversationSchema),
    page: PageInfoSchema,
  })
  .passthrough();
export type DmConversationsResponse = z.infer<typeof DmConversationsResponseSchema>;

/** POST .../dms/{dmId}/messages body (`dm-message-create-request`). */
export const DmMessageCreateRequestSchema = z
  .object({
    clientMessageId: z.string().min(1),
    /**
     * The recipient actor (OFSCP §7.4). When present the provider verifies it is
     * local and that `{dmId}` derives from (author, to); when absent it falls
     * back to searching its local users.
     */
    to: UserRefSchema.optional(),
    content: ContentSchema,
    attachments: z.array(AttachmentSchema).optional(),
    mentions: MentionsSchema.optional(),
    reference: MessageReferenceSchema.optional(),
  })
  .passthrough();
export type DmMessageCreateRequest = z.infer<typeof DmMessageCreateRequestSchema>;

/**
 * PUT /api/me/dms/{dmId} body (OFSCP §7.4 conversation pointers): record on the
 * caller's HOME provider that they have a conversation with `with`, plus an
 * optional non-authoritative preview of the message they just sent.
 */
export const DmConversationPointerRequestSchema = z
  .object({
    with: UserRefSchema,
    lastMessage: MessageSchema.optional(),
  })
  .passthrough();
export type DmConversationPointerRequest = z.infer<typeof DmConversationPointerRequestSchema>;
