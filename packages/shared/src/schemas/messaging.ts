/**
 * OFSCP v0.1 messaging schemas — mirrors `defs/messaging.json` plus the
 * top-level message / reaction / messages-page / DM documents.
 */
import { z } from "zod";

import {
  AttachmentSchema,
  DmIdSchema,
  HttpsUriSchema,
  MetadataListSchema,
  MimeTypeSchema,
  OpaqueCursorSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Message primitives (defs/messaging.json)
// ---------------------------------------------------------------------------

/** Message body text + mime (`Content`). */
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

// ---------------------------------------------------------------------------
// Message (message.json → BaseMessage; the message|memo|article variants)
// ---------------------------------------------------------------------------

/** The message kind discriminator (`BaseMessage.type`, §5.3). */
export const MessageKindSchema = z.enum(["message", "memo", "article"]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/** A chat/memo/article message (`BaseMessage`). */
export const MessageSchema = z
  .object({
    id: z.string().min(1),
    author: UserRefSchema,
    type: MessageKindSchema,
    content: ContentSchema,
    attachments: z.array(AttachmentSchema),
    reference: MessageReferenceSchema.optional(),
    tags: z.array(z.string()).optional(),
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

/** Union of message-like items found in timelines (`TimelineItem`). */
export const TimelineItemSchema = z.union([MessageSchema, ReactionSchema]);
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

/** PATCH .../messages/{messageId} body (`message-update-request`). */
export const MessageUpdateRequestSchema = z
  .object({
    content: ContentSchema,
  })
  .passthrough();
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
    content: ContentSchema,
    attachments: z.array(AttachmentSchema).optional(),
    reference: MessageReferenceSchema.optional(),
  })
  .passthrough();
export type DmMessageCreateRequest = z.infer<typeof DmMessageCreateRequestSchema>;
