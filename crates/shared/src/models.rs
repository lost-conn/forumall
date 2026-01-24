//! Shared data models for the OFSCP protocol and forumall application.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// --- Common Definitions ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Discoverability {
    Private,
    Group,
    Public,
    Discoverable,
}

pub fn validate_resource_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
        })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum VisibilityPolicy {
    Public,
    Authenticated,
    SharedGroups,
    Contacts,
    Nobody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataItem {
    pub schema: String,
    pub version: String,
    pub data: serde_json::Value,
}

pub type Metadata = Vec<MetadataItem>;

// --- Identity ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum UserRef {
    Uri(String),
    Handle(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub handle: String,
    pub domain: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserAccount {
    pub profile: UserProfile,
    pub settings: serde_json::Value,
}

// --- Objects ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub mime: String,
    pub url: String,
    pub size: u64,
}

// --- Messaging ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub text: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReference {
    #[serde(rename = "type")]
    pub r#type: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub edit_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseMessage {
    pub id: String,
    pub author: UserRef,
    #[serde(rename = "type")]
    pub r#type: MessageType,
    /// Optional title for Article messages
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub content: Content,
    pub attachments: Vec<Attachment>,
    pub reference: Option<MessageReference>,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub permissions: Option<Permissions>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MessageType {
    Message,
    Memo,
    Article,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub id: String,
    pub author: UserRef,
    pub key: String,
    pub unicode: Option<String>,
    pub image: Option<String>,
    pub reference: MessageReference,
    pub created_at: DateTime<Utc>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum TimelineItem {
    Message(BaseMessage),
    Reaction(Reaction),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PagedResponse<T> {
    pub items: Vec<T>,
    pub page: PageInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

// --- Discovery ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryDocument {
    pub provider: ProviderInfo,
    pub capabilities: Capabilities,
    pub endpoints: Endpoints,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub domain: String,
    pub protocol_version: String,
    pub software: SoftwareInfo,
    pub contact: String,
    pub authentication: AuthenticationEndpoints,
    pub public_keys: Option<Vec<PublicKey>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationEndpoints {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: String,
    pub jwks_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicKey {
    pub kid: String,
    pub alg: PublicKeyAlg,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PublicKeyAlg {
    Ed25519,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub message_types: Vec<MessageType>,
    pub discoverability: Vec<Discoverability>,
    pub metadata_schemas: Vec<MetadataSchemaInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSchemaInfo {
    pub id: String,
    pub uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub identity: String,
    pub groups: String,
    pub notifications: String,
    pub tiers: String,
}

// --- WebSocket ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsEnvelope<T> {
    pub id: String,
    #[serde(flatten)]
    pub payload: T,
    pub ts: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ClientCommand {
    Subscribe {
        channel_id: String,
    },
    Unsubscribe {
        channel_id: String,
    },
    #[serde(rename = "message.create")]
    MessageCreate {
        channel_id: String,
        body: String,
        nonce: String,
        /// Optional title for Article messages
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// Message type (defaults to Message)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_type: Option<MessageType>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ServerEvent {
    #[serde(rename = "message.new")]
    MessageNew {
        channel_id: String,
        message: BaseMessage,
    },
    Ack {
        nonce: String,
        message_id: String,
    },
    Error {
        code: String,
        message: String,
        correlation_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserJoinedGroup {
    pub group_id: String,
    pub host: Option<String>,
    pub name: String,
    pub joined_at: String,
}

// --- Groups ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default = "default_join_policy")]
    pub join_policy: String,
    pub owner: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_join_policy() -> String {
    "open".to_string()
}

// --- Channels ---

/// Channel type (text or call)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChannelType {
    #[default]
    Text,
    Call,
}

/// Permission target - can be a role (@everyone, @admin, @owner, @custom)
/// or an individual user ID (no @ prefix)
pub type PermissionTarget = String;

fn default_view_permission() -> Vec<PermissionTarget> {
    vec!["@everyone".to_string()]
}

fn default_send_permission() -> Vec<PermissionTarget> {
    vec!["@everyone".to_string()]
}

/// Channel permission settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPermissions {
    /// Who can view the channel (default: ["@everyone"])
    /// Accepts: "@everyone", "@admin", "@owner", "@customrole", or user IDs
    #[serde(default = "default_view_permission")]
    pub view: Vec<PermissionTarget>,
    /// Who can send messages (default: ["@everyone"])
    #[serde(default = "default_send_permission")]
    pub send: Vec<PermissionTarget>,
}

impl Default for ChannelPermissions {
    fn default() -> Self {
        Self {
            view: default_view_permission(),
            send: default_send_permission(),
        }
    }
}

fn default_root_types() -> Vec<MessageType> {
    vec![MessageType::Message, MessageType::Memo, MessageType::Article]
}

fn default_reply_types() -> Vec<MessageType> {
    vec![MessageType::Message, MessageType::Memo, MessageType::Article]
}

/// Message type settings for a channel
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageTypeSettings {
    /// Allowed types for root/top-level messages
    #[serde(default = "default_root_types")]
    pub root_types: Vec<MessageType>,
    /// Allowed types for replies
    #[serde(default = "default_reply_types")]
    pub reply_types: Vec<MessageType>,
}

impl Default for MessageTypeSettings {
    fn default() -> Self {
        Self {
            root_types: default_root_types(),
            reply_types: default_reply_types(),
        }
    }
}

/// Full channel settings object
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSettings {
    #[serde(default)]
    pub permissions: ChannelPermissions,
    #[serde(default)]
    pub message_types: MessageTypeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub group_id: String,
    pub name: String,
    #[serde(default)]
    pub channel_type: ChannelType,
    pub topic: Option<String>,
    #[serde(default)]
    pub discoverability: Option<Discoverability>,
    #[serde(default)]
    pub settings: ChannelSettings,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub metadata: Metadata,
    pub created_at: String,
    pub updated_at: String,
}

// --- Auth Request/Response Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub handle: String,
    pub password: String,
    pub device_public_key: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub handle: String,
    pub password: String,
    pub device_public_key: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub user_id: String,
    pub key_id: Option<String>,
}

// --- Group Request/Response Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub join_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub channel_type: Option<ChannelType>,
    #[serde(default)]
    pub discoverability: Option<Discoverability>,
    #[serde(default)]
    pub settings: Option<ChannelSettings>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub discoverability: Option<Discoverability>,
    pub settings: Option<ChannelSettings>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelSettingsRequest {
    pub permissions: Option<ChannelPermissions>,
    pub message_types: Option<MessageTypeSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberRequest {
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroupSettingsRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub join_policy: Option<String>,
}

/// Alias for consistency
pub type UpdateGroupRequest = UpdateGroupSettingsRequest;

// --- Messages Page ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPage {
    pub items: Vec<ChannelMessage>,
    pub page: PageInfo,
}

// --- Device Keys ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKey {
    pub key_id: String,
    pub user_handle: String,
    pub public_key: String,
    pub device_name: String,
    pub created_at: String,
    pub last_used_at: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceKeyRequest {
    pub public_key: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceKeyResponse {
    pub key_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryKey {
    pub key_id: String,
    pub algorithm: String,
    pub public_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeyDiscoveryResponse {
    pub actor: String,
    pub keys: Vec<DiscoveryKey>,
    pub cache_until: String,
}

// --- Messages ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageRequest {
    pub body: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub id: String,
    pub channel_id: String,
    pub sender_user_id: String,
    /// Optional title for Article messages
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
    /// Message type (Message, Memo, or Article)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_type: Option<MessageType>,
    pub created_at: String,
}

// --- Users ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddJoinedGroupRequest {
    pub group_id: String,
    pub host: Option<String>,
    pub name: String,
}
